#!/usr/bin/env bash
set -u
SESSION="full2-$$"
CAST="$1"
WDIR="${2:-/Users/duytrinh/Code/opencode-voice}"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 120 -y 36 -c "$WDIR" 'opencode'
sleep 8
asciinema rec -c "tmux attach -t $SESSION" --window-size 120x36 --overwrite "$CAST" >/tmp/scratchpad/asciilog 2>&1 &
REC_PID=$!
sleep 2

run(){ tmux send-keys -t "$SESSION" "$1"; sleep "${2:-1.5}"; }

# 1. TTS engine -> vienu (down twice)
run C-p 1.5; run "tts engine" 1.5; run Enter 2.5
run Down 0.8; run Down 0.8; run Enter 2.5
run Escape 1

# 2. TTS voice
run C-p 1.5; run "tts voice" 1.5; run Enter 2.5
run Down 0.8; run Enter 2.5
run Escape 1

# 3. STT mic
run C-p 1.5; run "stt mic" 1.5; run Enter 2.5
run Down 0.8; run Enter 2.5
run Escape 1

# 4. TTS rate
run C-p 1.5; run "tts rate" 1.5; run Enter 2.5
run Down 0.8; run Enter 2.5
run Escape 1

# 5. STT record (waveform) -> wait for user speech -> submit -> wait for agent reply
run C-p 1.5; run "stt record" 1.5; run Enter 7
run C-p 1; run "stt submit" 1; run Enter 10

# 6. TTS speak (only after agent responded)
run C-p 1.5; run "tts speak" 1.5; run Enter 7
run Escape 1

# 7. Voice conversation toggle
run C-p 1.5; run "voice conversation" 1.5; run Enter 6
run C-p 1; run "voice conversation stop" 1; run Enter 3
run Escape 1

run C-c 2
tmux kill-session -t "$SESSION" 2>/dev/null || true
wait $REC_PID 2>/dev/null || true
echo done
