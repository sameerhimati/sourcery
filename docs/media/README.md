# Demo assets

Recorded with [vhs](https://github.com/charmbracelet/vhs) from real runs against
live providers. The numbers on screen are results, not mockups — which is the
only reason a demo belongs in an eval's README at all.

The tapes are checked in so every asset can be re-recorded when the output
changes. A demo GIF that no longer matches the tool is worse than none.

## Recording

`vhs` needs the `sourcery` shim on PATH, which `.vhs-bin/` provides (gitignored —
it just points at `dist/index.js`, so `npm run build:cli` first). Providers and
models come from a local `sourcery.config.mjs`, also gitignored.

```bash
npm run build:cli
export PATH=$PWD/.vhs-bin:$PATH
vhs docs/media/hero.tape
```

**Warm the fetch cache first** by running the same query once. Fetches are cached
for 24h, so an unwarmed recording sits on live retrieval for a minute. The LLM
calls still happen live either way, so the scores are real each time — expect
different numbers on a re-record, and re-caption if the story changes.

## hero.gif

Four providers, one query, ~89 seconds of real time. Playback is compressed 7×
because nobody watches a 90-second GIF, and the `LATENCY` column keeps the true
per-arm timings on screen.

```bash
ffmpeg -y -i hero-raw.mp4 \
  -vf "setpts=PTS/7,fps=13,scale=1240:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 hero.gif
```

The README says it's sped up, right under the image. Keep that caption if you
re-record.

## demo.mp4 / demo.gif

The long one, for X, HN, or anywhere the README isn't doing the talking. Four
acts — what's configured, one query across four providers, why there are two
scores, and how an agent consults it — from `demo.tape`, ~112 seconds of real
time at 4× playback.

Shell comments carry the narration, since vhs has no text overlay. Interactive
zsh doesn't treat `#` as a comment unless told to, so the tape sets
`interactive_comments`; without it every narration line prints
`command not found: #`.

```bash
# X, and anything that would rather have video than a 500 KB gif
ffmpeg -y -i demo-raw.mp4 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -vf "setpts=PTS/4,fps=30" -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 20 \
  -movflags +faststart -c:a aac -shortest demo.mp4

# gif, for markdown that can't embed video
ffmpeg -y -i demo-raw.mp4 \
  -vf "setpts=PTS/4,fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 demo.gif
```

The silent audio track is deliberate: some platforms reject or mis-handle a
video-only mp4.

The best single frame is act three — `report --tui`, where the short coloured
retrieval bars sit against the long grey answer bars for every provider. That's
the r = 0.16 result as a picture, and it's the frame to lead a post with.
