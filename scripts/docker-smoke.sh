#!/usr/bin/env bash
# Build the Docker image and smoke-test a container of it (pnpm run ci:docker).
#
#   bash scripts/docker-smoke.sh
#
# docker build --check (no warnings), build, run with a fresh named volume on a random loopback
# port, wait for Docker's health status "healthy" while the API reports "degraded", run
# scripts/smoke.sh, check uid 1000, write the minimal configuration -> "healthy", and require
# `docker stop` to finish within 5 s with exit code 0. The container, volume and image tag are
# removed on exit; the build cache is kept. Needs bash, curl and Docker Engine >= 25.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
MINIMAL_CONFIG='{"version":1,"certificates":{},"targets":{},"paths":{}}'
ID=aia-cdp-smoke-$$-$RANDOM
IMAGE=$ID:latest NAME=$ID VOLUME=$ID

die() {
  printf 'docker-smoke: %s\n' "$*" >&2
  exit 1
}
command -v docker >/dev/null || die "docker is required"
command -v curl >/dev/null || die "curl is required"

created=0
cleanup() {
  if ((created)); then
    docker rm -f -v "$NAME" >/dev/null 2>&1 || true
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    docker image rm "$IMAGE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

failures=0
check() { # OK_STATUS DESCRIPTION
  if [[ $1 == 0 ]]; then
    printf 'ok    %s\n' "$2"
  else
    printf 'FAIL  %s\n' "$2"
    failures=$((failures + 1))
  fi
}
logs() {
  echo "--- container logs" >&2
  docker logs "$NAME" >&2 2>&1 || true
}

echo "docker-smoke: docker build --check ."
docker build --check . || die "docker build --check reported warnings or errors"

created=1
echo "docker-smoke: building $IMAGE"
docker build -t "$IMAGE" .
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -p 127.0.0.1::8080 -v "$VOLUME:/data" "$IMAGE" >/dev/null
hostport=$(docker port "$NAME" 8080/tcp | head -n 1)
BASE=http://127.0.0.1:${hostport##*:}

started=$(date +%s%3N)
state=''
for _ in $(seq 240); do # 60 s
  state=$(docker inspect -f '{{.State.Status}}/{{.State.Health.Status}}' "$NAME")
  case $state in
    running/healthy | running/unhealthy | exited/* | dead/*) break ;;
  esac
  sleep 0.25
done
if [[ $state != running/healthy ]]; then
  logs
  die "container state $state after $(($(date +%s%3N) - started)) ms, want running/healthy"
fi
check 0 "container healthy after $(($(date +%s%3N) - started)) ms ($BASE)"

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

uid=$(docker exec "$NAME" id -u)
if [[ $uid == 1000 ]]; then ok=0; else ok=1; fi
check "$ok" "runs as uid $uid (want 1000)"

docker exec -i "$NAME" sh -c 'cat >/data/config.json' <<<"$MINIMAL_CONFIG"
health healthy

started=$(date +%s%3N)
docker stop "$NAME" >/dev/null
elapsed=$(($(date +%s%3N) - started))
if ((elapsed < 5000)); then ok=0; else ok=1; fi
check "$ok" "docker stop took $elapsed ms (want < 5000)"
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
if [[ $code == 0 ]]; then ok=0; else ok=1; fi
check "$ok" "exit code $code after docker stop (want 0)"

if ((failures > 0)); then
  logs
  die "$failures check(s) failed"
fi
echo "docker-smoke: all checks passed"
