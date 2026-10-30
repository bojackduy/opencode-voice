#!/usr/bin/env bash
# Full-stack recorder: terminal (asciinema) + microphone (sox) -> MP4 with audio.
# Usage: scripts/record-with-audio.sh <out_basename> [project_dir]
# Speak during the STT recording phase; audio is muxed into the final MP4.
set -u
BASE="${1:-demo}"
DIR="${2:-/Users/duytrinh/Code/opencode-voice}"
OUTDIR="$(dirname "$0")/../assets"
mkdir -p "$OUTDIR"
CAST="$OUTDIR/$BASE.cast"
WAV="$OUTDIR/$BASE.wav"
MP4="$OUTDIR/$BASE.mp4"
GIF="$OUTDIR/$BASE.gif"

SESSION="rec-$BASE-$$"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 120 -y 36 -c "$DIR" 'opencode'
sleep 7

# Start mic recording in background (sox). Stop with: kill $SOX_PID
sox -d -r 44100 -c 1 "$WAV" >/dev/null 2>&1 &
SOX_PID=$!

asciinema rec -c "tmux attach -t $SESSION" --window-size 120x36 --overwrite "$CAST" >/dev/null 2>&1 &
REC_PID=$!
sleep 2

# Drive the UI; speak during the stt record step.
run(){ tmux send-keys -t "$SESSION" "$1"; sleep "${2:-1.5}"; }
run C-p 1.5; run "tts engine" 1.5; run Enter 2; run Down 0.7; run Down 0.7; run Enter 2; run Escape 1
run C-p 1.5; run "tts voice" 1.5; run Enter 2; run Down 0.7; run Enter 2; run Escape 1
run C-p 1.5; run "stt mic" 1.5; run Enter 2; run Down 0.7; run Enter 2; run Escape 1
run C-p 1.5; run "stt record" 1.5; run Enter 6   # <-- SPEAK NOW
run C-p 1; run "stt submit" 1; run Enter 4
run C-p 1.5; run "voice conversation" 1.5; run Enter 5
run C-p 1; run "voice conversation stop" 1; run Enter 3
run C-p 1.5; run "tts speak" 1.5; run Enter 4
run Escape 1
run C-c 2

# Stop recordings
kill $SOX_PID 2>/dev/null || true
tmux kill-session -t "$SESSION" 2>/dev/null || true
wait $REC_PID 2>/dev/null || true

# Build GIF + MP4 (with audio)
agg "$CAST" "$GIF" --speed 2 --idle-time-limit 0.5 >/dev/null 2>&1
ffmpeg -y -i "$GIF" -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" "${MP4%.mp4}_silent.mp4" >/dev/null 2>&1
ffmpeg -y -i "${MP4%.mp4}_silent.mp4" -i "$WAV" -c:v copy -c:a aac -b:a 128k -shortest -movflags faststart "$MP4" >/dev/null 2>&1
rm -f "${MP4%.mp4}_silent.mp4"
echo "Done: $GIF  $MP4  $WAV"
