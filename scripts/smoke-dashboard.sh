#!/usr/bin/env bash
# Dashboard gate: the app is a *view* over .sourcery/runs.jsonl, so the thing
# that must never silently break is /api/runs reading that file per request and
# the page rendering off it. Boots `next dev` against a seeded fixture log —
# no API keys, no provider credits, nothing live.
#
# The empty-then-seeded sequence is the real assertion: it proves the route
# re-reads the contract file at request time instead of freezing a snapshot,
# which is exactly the regression that orphaned this dashboard before.
#
# Usage: scripts/smoke-dashboard.sh   (PORT=3117 by default)
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3117}"
BASE="http://127.0.0.1:$PORT"
RUNS=".sourcery/runs.jsonl"
BACKUP=".sourcery/runs.jsonl.smoke-backup"

command -v node >/dev/null 2>&1 || { echo "FAIL: no node on PATH"; exit 1; }

server_pid=""
restore=0
cleanup() {
  if [ -n "$server_pid" ]; then
    pkill -P "$server_pid" >/dev/null 2>&1 || true   # turbopack forks children
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
  # A stray listener would poison the next run, so reclaim the port explicitly.
  stray="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  [ -n "$stray" ] && kill $stray >/dev/null 2>&1 || true
  rm -f "$RUNS"
  [ "$restore" = 1 ] && mv "$BACKUP" "$RUNS"
  return 0
}
trap cleanup EXIT INT TERM

# Never eat a real run log: park it and put it back in the trap.
mkdir -p .sourcery
if [ -f "$RUNS" ]; then mv "$RUNS" "$BACKUP"; restore=1; fi

log="$(mktemp -t sourcery-smoke)"
npx next dev --port "$PORT" >"$log" 2>&1 &
server_pid=$!

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/runs" >/dev/null 2>&1 && break
  kill -0 "$server_pid" 2>/dev/null || { echo "FAIL: dev server died:"; cat "$log"; exit 1; }
  sleep 1
done

assert() { node -e "$2" "$1" || exit 1; }

# 1. Fresh install: no contract file at all → empty, not a crash.
empty="$(curl -sf "$BASE/api/runs")" || { echo "FAIL: GET /api/runs (empty)"; cat "$log"; exit 1; }
assert "$empty" '
  const d = JSON.parse(process.argv[1]);
  if (d.records !== 0 || d.rows.length || d.heatmap.length || d.runs_per_cell !== 0) {
    console.error("FAIL: expected an empty payload, got", process.argv[1]); process.exit(1);
  }
'

# 2. Seed the contract file *while the server is up* — one `sourcery run` record
#    plus six batch rows across two query types.
cat > "$RUNS" <<'JSONL'
{"mode":"run","id":"run_smoke","ts":"2026-07-25T00:00:00.000Z","query":"smoke query","variable":"provider","winner":"bright_data","judge_model":"gpt-4o-mini","arms":[{"id":"bright_data","provider":"bright_data","config":{"freshness":"all","num_sources":8,"extraction":"clean"},"model":"gpt-4o-mini","answer":"a","sources":[],"latency_ms":10,"retrieval_score":8,"retrieval_rationale":"","score":7,"rationale":""}]}
{"mode":"batch","batchId":"batch_smoke","ts":"2026-07-25T00:00:00.000Z","row":{"queryId":"bn-1","type":"breaking_news","query":"q1","provider":"bright_data","retrieval_score":9,"answer_score":8,"retrieval_rationale":"","median_source_age_days":1,"num_sources":8,"num_sources_extracted":8,"latency_ms":100}}
{"mode":"batch","batchId":"batch_smoke","ts":"2026-07-25T00:00:00.000Z","row":{"queryId":"bn-2","type":"breaking_news","query":"q2","provider":"bright_data","retrieval_score":8,"answer_score":8,"retrieval_rationale":"","median_source_age_days":1,"num_sources":8,"num_sources_extracted":8,"latency_ms":100}}
{"mode":"batch","batchId":"batch_smoke","ts":"2026-07-25T00:00:00.000Z","row":{"queryId":"bn-1","type":"breaking_news","query":"q1","provider":"firecrawl","retrieval_score":6,"answer_score":7,"retrieval_rationale":"","median_source_age_days":2,"num_sources":8,"num_sources_extracted":8,"latency_ms":100}}
{"mode":"batch","batchId":"batch_smoke","ts":"2026-07-25T00:00:00.000Z","row":{"queryId":"bn-2","type":"breaking_news","query":"q2","provider":"firecrawl","retrieval_score":6,"answer_score":7,"retrieval_rationale":"","median_source_age_days":2,"num_sources":8,"num_sources_extracted":8,"latency_ms":100}}
{"mode":"batch","batchId":"batch_smoke","ts":"2026-07-25T00:00:00.000Z","row":{"queryId":"ht-1","type":"how_to","query":"q3","provider":"bright_data","retrieval_score":4,"answer_score":5,"retrieval_rationale":"","median_source_age_days":90,"num_sources":8,"num_sources_extracted":8,"latency_ms":100}}
{"mode":"batch","batchId":"batch_smoke","ts":"2026-07-25T00:00:00.000Z","row":{"queryId":"ht-1","type":"how_to","query":"q3","provider":"firecrawl","retrieval_score":7,"answer_score":6,"retrieval_rationale":"","median_source_age_days":30,"num_sources":8,"num_sources_extracted":8,"latency_ms":100}}
JSONL

seeded="$(curl -sf "$BASE/api/runs")" || { echo "FAIL: GET /api/runs (seeded)"; cat "$log"; exit 1; }
assert "$seeded" '
  const d = JSON.parse(process.argv[1]);
  const fail = (m) => { console.error("FAIL: " + m + "\n" + process.argv[1]); process.exit(1); };
  if (d.path !== ".sourcery/runs.jsonl") fail("path " + d.path);
  if (d.records !== 7) fail("records " + d.records + " (want 7: 1 run + 6 batch rows)");
  if (d.rows.length !== 6) fail("rows " + d.rows.length + " (want 6 — the run record must not be plotted)");
  if (d.heatmap.length !== 2) fail("heatmap cells " + d.heatmap.length + " (want 2)");
  const [bn, ht] = d.heatmap;
  if (bn.type !== "breaking_news" || ht.type !== "how_to") fail("heatmap out of dataset order");
  if (bn.bright_data !== 8.5 || bn.firecrawl !== 6) fail("breaking_news averages wrong");
  if (bn.runs !== 2 || ht.runs !== 1) fail("runs-per-cell counts wrong");
  if (d.runs_per_cell !== 2) fail("runs_per_cell " + d.runs_per_cell + " (want 2)");
'

# 3. The page itself still renders (it fetches /api/runs client-side).
# Retried: layout.tsx pulls two families through next/font/google, and on a cold
# dev cache that fetch can stall past a minute and 500 the first compile. That's
# a font CDN round-trip, not the dashboard — failing the gate on it would train
# everyone to re-run a red build until it goes green.
code=""
for _ in 1 2 3; do
  code="$(curl -s --max-time 180 -o /dev/null -w "%{http_code}" "$BASE/")"
  [ "$code" = "200" ] && break
done
[ "$code" = "200" ] || { echo "FAIL: GET / returned $code"; cat "$log"; exit 1; }

rm -f "$log"
echo "smoke-dashboard: PASS (empty log → empty payload; seeded log → live heatmap; / renders)"
