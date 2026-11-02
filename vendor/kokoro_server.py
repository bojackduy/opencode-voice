#!/usr/bin/env python3
"""Kokoro TTS sidecar for opencode-voice.

Kokoro is a local, open-weights English TTS with natural prosody. It runs as
a Python sidecar serving WAV bytes over plain HTTP, mirroring
vendor/chatterbox_server.py so the Node side can reuse the same client shape
(lib/kokoro-server.js, port 8130).

Design constraints (same as chatterbox_server.py):
- stdlib http.server only. The only non-stdlib dependency is "kokoro" (and
  "soundfile" for WAV encoding), installed on first run.
- /health answers before and during model load, so a broken install reports a
  real reason instead of a connection refusal.
- Logs go to stderr only.
- Written for Python 3.9+: no match statements, no PEP 604 unions.
"""

import argparse
import io
import json
import os
import sys
import threading
import traceback
import wave

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {
    "model": None,  # KPipeline instance
    "phase": "loading",  # loading | ready | failed
    "error": None,
    "voice": "af_heart",
    "lock": threading.Lock(),
}


def log(message):
    sys.stderr.write("[kokoro] %s\n" % message)
    sys.stderr.flush()


def load_model():
    try:
        import numpy as np  # noqa: F401
    except Exception as err:  # pragma: no cover
        raise RuntimeError("numpy is not importable in this interpreter (%s)" % err)
    try:
        from kokoro import KPipeline
    except Exception as err:  # pragma: no cover
        raise RuntimeError("kokoro is not installed in this interpreter (%s)" % err)
    # 'a' = American English; Kokoro also supports 'b' (British English).
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    STATE["model"] = pipeline
    STATE["phase"] = "ready"
    STATE["error"] = None


def synthesize(pipeline, text, voice):
    import numpy as np

    chunks = []
    for _, _, audio in pipeline(text, voice=voice, speed=1.0):
        if audio is None:
            continue
        arr = np.asarray(audio)
        if arr.size == 0:
            continue
        chunks.append(arr.reshape(-1))
    if not chunks:
        raise RuntimeError("kokoro produced no audio")
    samples = np.concatenate(chunks).astype("float32")
    # Convert float32 [-1, 1] to int16 PCM.
    pcm = (samples * 32767.0).clip(-32768, 32767).astype("int16")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "kokoro-sidecar/1.0"

    def log_message(self, fmt, *args):
        log("http %s" % (fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path != "/health":
            self._send_json(404, {"ok": False, "error": "not found: %s" % path})
            return
        ok = STATE["phase"] == "ready"
        payload = {"ok": ok, "status": STATE["phase"]}
        if STATE["error"]:
            payload["error"] = STATE["error"]
        self._send_json(200 if ok else 503, payload)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/speak":
            self._send_json(404, {"ok": False, "error": "not found: %s" % path})
            return
        if STATE["phase"] != "ready" or STATE["model"] is None:
            self._send_json(
                503,
                {"ok": False, "error": STATE["error"] or "model still loading", "phase": STATE["phase"]},
            )
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"ok": False, "error": "empty request body"})
            return
        try:
            req = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as err:
            self._send_json(400, {"ok": False, "error": "invalid JSON: %s" % err})
            return
        text = (req.get("text") or "").strip()
        if not text:
            self._send_json(400, {"ok": False, "error": "text is required"})
            return
        voice = req.get("voice") or STATE["voice"]
        try:
            with STATE["lock"]:
                wav = synthesize(STATE["model"], text, voice)
        except Exception as err:
            log("synthesize failed: %s" % err)
            traceback.print_exc(file=sys.stderr)
            self._send_json(500, {"ok": False, "error": "synthesis failed: %s" % err})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def preload():
    try:
        load_model()
    except BaseException as err:
        # BaseException on purpose: a runtime dependency fetcher that calls
        # sys.exit (e.g. a missing spacy model trying to pip-install itself)
        # would otherwise kill this thread silently and leave /health on
        # "loading" forever while clients poll the full ready timeout.
        STATE["phase"] = "failed"
        STATE["error"] = "%s: %s" % (type(err).__name__, err)
        log("model load FAILED: %s: %s" % (type(err).__name__, err))
        traceback.print_exc(file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Kokoro TTS sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8130)
    parser.add_argument("--voice", default="af_heart")
    args = parser.parse_args()

    STATE["voice"] = args.voice

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    threading.Thread(target=preload, args=(), daemon=True).start()
    log("listening on %s:%d voice=%s" % (args.host, args.port, args.voice))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
