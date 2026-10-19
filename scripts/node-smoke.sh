#!/usr/bin/env bash
# Smoke test of the compiled Node runtime (dist/server + dist/web), as production runs it.
#
#   pnpm run build && bash scripts/node-smoke.sh          (pnpm run smoke:node; part of ci:test)
#
# Starts `node --enable-source-maps dist/server/runtime/node.js` with PORT=0 and a fresh data
# directory, takes the port from the "listening" log line, runs scripts/smoke.sh, checks health
# degraded -> healthy after writing the minimal configuration, then sends SIGTERM and expects
# exit 0 within 12 s with JSON-only stdout. Needs bash, curl and Node 24 on PATH.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
MINIMAL_CONFIG='{"version":1,"certificates":{},"targets":{},"paths":{}}'

die() {
  printf 'node-smoke: %s\n' "$*" >&2
  exit 1
}
[[ -f dist/server/runtime/node.js && -f dist/web/index.html ]] ||
  die "dist/server/runtime/node.js or dist/web/index.html is missing: run pnpm run build first"
command -v curl >/dev/null || die "curl is required"
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || die "node is not on PATH"
((major >= 24)) ||
  die "need Node 24, found $(node -v): export PATH=\$HOME/.local/opt/node-24/bin:\$PATH"

T=$(mktemp -d "${TMPDIR:-/tmp}/aia-cdp-node-smoke.XXXXXX")
pid=''
cleanup() {
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -rf "$T"
}
trap cleanup EXIT
mkdir "$T/data"

failures=0
check() { # OK_STATUS DESCRIPTION
  if [[ $1 == 0 ]]; then
    printf 'ok    %s\n' "$2"
  else
    printf 'FAIL  %s\n' "$2"
    failures=$((failures + 1))
  fi
}
show_logs() {
  echo "--- server stdout" >&2
  cat "$T/stdout" >&2
  echo "--- server stderr" >&2
  cat "$T/stderr" >&2
}

# Only the variables set here: an AIA_* from the caller's shell must not change the run.
while read -r name; do unset "$name"; done < <(compgen -e | grep '^AIA_' || true)
PORT=0 AIA_DATA_DIR="$T/data" AIA_STATIC_DIR="$ROOT/dist/web" \
  node --enable-source-maps dist/server/runtime/node.js </dev/null >"$T/stdout" 2>"$T/stderr" &
pid=$!

port=''
for _ in $(seq 150); do # 15 s
  line=$(grep -m 1 '"msg":"listening"' "$T/stdout" || true)
  port=$(sed -nE 's/.*"port":([0-9]+).*/\1/p' <<<"$line")
  if [[ -n $port ]] || ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ -z $port ]]; then
  show_logs
  die "no listening log line within 15 s"
fi
BASE=http://127.0.0.1:$port
echo "node-smoke: $(node -v) listening on $BASE, data $T/data"

health() { # EXPECTED_STATUS: health answers 200 with that status
  local out ok=1
  out=$(curl -sS --max-time 5 -w '\n%{http_code}' "$BASE/api/v1/health" 2>&1) || true
  if [[ ${out##*$'\n'} == 200 && $out == *"\"status\":\"$1\""* ]]; then ok=0; fi
  check "$ok" "health is $1: ${out//$'\n'/ }"
}

health degraded

smoke=0
bash scripts/smoke.sh "$BASE" || smoke=$?
check "$smoke" "scripts/smoke.sh $BASE"

printf '%s\n' "$MINIMAL_CONFIG" >"$T/data/config.json"
health healthy

kill -TERM "$pid" 2>/dev/null || true
started=$(date +%s%3N)
for _ in $(seq 120); do # 12 s
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$pid" 2>/dev/null; then
  check 1 "exits within 12 s of SIGTERM"
  kill -KILL "$pid"
fi
code=0
wait "$pid" || code=$?
pid=''
check "$code" "SIGTERM -> exit $code after $(($(date +%s%3N) - started)) ms"
logged=0
grep -q '"msg":"shutdown"' "$T/stdout" || logged=1
check "$logged" "logged shutdown"

json=0
node -e '
  const lines = require("node:fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  const bad = lines.filter((l) => {
    try {
      const o = JSON.parse(l);
      return typeof o.level !== "string" || typeof o.msg !== "string";
    } catch {
      return true;
    }
  });
  for (const l of bad) console.error("not a JSON log line: " + l);
  process.exit(bad.length === 0 && lines.length > 0 ? 0 : 1);
' "$T/stdout" || json=1
check "$json" "stdout is JSON lines with level and msg ($(wc -l <"$T/stdout") lines)"

if ((failures > 0)); then
  show_logs
  die "$failures check(s) failed"
fi
echo "node-smoke: all checks passed"
