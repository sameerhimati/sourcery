#!/usr/bin/env bash
# Retime the demo capture: compress the waiting, hold the reading.
#
# A single global speed-up is the wrong tool here. The raw capture is 112s, of
# which 69 are a progress spinner and nothing else, while every screen worth
# reading — the provider table, the scorecard, the bars — is on screen for two
# to six seconds. Playing it all at 4x makes the dead part tolerable and the
# readable parts unreadable.
#
# So: the spinner runs at 12x, the typing plays at 1x, and every screen with
# something to read is STRETCHED past its recorded duration. Nothing is
# reordered and no frame is fabricated; the LATENCY column still shows the real
# per-arm timings, and the sped-up stretch is the one where nothing happens.
#
# Boundaries come from measuring per-second frame complexity (a near-empty
# spinner screen compresses to ~7KB, a full scorecard to ~37KB), not from
# guessing. Re-derive them after any re-record:
#
#   ffmpeg -i demo-raw.mp4 -vf "fps=1,scale=350:-1" frames/f%03d.png
#   for f in frames/*.png; do echo "$f $(stat -f%z "$f")"; done
#
set -euo pipefail
cd "$(dirname "$0")"

IN=demo-raw.mp4
OUT=demo.mp4

# start end  speed-divisor  (>1 = faster, <1 = slower/held)
SEGMENTS=(
  "0     5      1.0"    # typing: what am I set up for
  "5     7      0.4"    # READ: provider table + credit balance
  "7     16     1.0"    # typing: the experiment setup
  "16    85     12.0"   # WAIT: four arms fetching + judging. Nothing to see.
  "85    89     0.55"   # READ: the scorecard. The money shot.
  "89    95     1.0"    # typing
  "95    101    0.65"   # READ: retrieval vs answer bars, every provider
  "101   106    1.0"    # typing
  "106   111.88 0.7"    # READ: the MCP registration lines
)

filter=""
labels=""
i=0
for seg in "${SEGMENTS[@]}"; do
  read -r start end div <<<"$seg"
  filter+="[0:v]trim=${start}:${end},setpts=(PTS-STARTPTS)/${div}[v${i}];"
  labels+="[v${i}]"
  i=$((i + 1))
done
filter+="${labels}concat=n=${i}:v=1:a=0,fps=30[out]"

ffmpeg -y -i "$IN" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -filter_complex "$filter" \
  -map "[out]" -map 1:a \
  -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 20 -movflags +faststart \
  -c:a aac -shortest "$OUT" 2>/dev/null

# The gif is the same retiming, smaller and paletted, for markdown that can't
# embed video.
ffmpeg -y -i "$OUT" \
  -vf "fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 demo.gif 2>/dev/null

printf 'demo.mp4  %s  %s\n' "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s" "$(du -h "$OUT" | cut -f1)"
printf 'demo.gif  %s\n' "$(du -h demo.gif | cut -f1)"
