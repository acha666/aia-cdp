#!/usr/bin/env bash
# Build the Docker image and smoke-test a container of it (pnpm run ci:docker).
#
#   bash scripts/docker-smoke.sh
#
# docker build --check (no warnings), build, run with a fresh named volume on a random loopback
# port and an admin token, wait for Docker's health status "healthy" while the API reports
# "degraded", run scripts/smoke.sh, check uid 1000, then use the image's own CLI
# (dist/server/cli/aia.js, via docker exec) to import the fixture CA certificates (docker cp'd in)
# and apply a configuration -> "healthy", and require `docker stop` to finish within 5 s with exit
# code 0. The container, volume and image tag are removed on exit; the build cache is kept. Needs
# bash, curl, sha256sum and Docker Engine >= 25.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
ID=aia-cdp-smoke-$$-$RANDOM
IMAGE=$ID:latest NAME=$ID VOLUME=$ID
CERTS=tests/fixtures/pki/certs
# Passed by name (docker run -e AIA_ADMIN_TOKEN), so it never appears on a command line.
AIA_ADMIN_TOKEN=smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export AIA_ADMIN_TOKEN

die() {
  printf 'docker-smoke: %s\n' "$*" >&2
  exit 1
}
command -v docker >/dev/null || die "docker is required"
command -v curl >/dev/null || die "curl is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

T=$(mktemp -d "${TMPDIR:-/tmp}/aia-cdp-docker-smoke.XXXXXX")
created=0
cleanup() {
  rm -rf "$T"
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
docker run -d --name "$NAME" -p 127.0.0.1::8080 -v "$VOLUME:/data" -e AIA_ADMIN_TOKEN \
  "$IMAGE" >/dev/null
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

# The CLI inside the image (exit 6 of implementation slice 2). docker exec inherits the container's
# AIA_ADMIN_TOKEN; the CLI only needs the URL.
aia() { docker exec -e AIA_URL=http://127.0.0.1:8080 "$NAME" node dist/server/cli/aia.js "$@"; }
aia_check() { # DESCRIPTION ERE ARGS...: the CLI exits 0 and its output matches ERE
  local description=$1 want=$2 out status=0 ok=1
  shift 2
  out=$(aia "$@" 2>&1) || status=$?
  if ((status == 0)) && [[ $out =~ $want ]]; then ok=0; fi
  check "$ok" "$description (exit $status): ${out//$'\n'/ | }"
}

# One DER file and one PEM bundle of two blocks; the config serves all three with fresh target ids
# from `aia new-target-id`.
mkdir "$T/smoke"
cp "$CERTS/root-ca.der" "$T/smoke/root-ca.der"
cat "$CERTS/issuing-ca-1.pem" "$CERTS/issuing-ca-2.pem" >"$T/smoke/chain.pem"
root=$(sha256sum "$CERTS/root-ca.der" | cut -d ' ' -f 1)
ca1=$(sha256sum "$CERTS/issuing-ca-1.der" | cut -d ' ' -f 1)
ca2=$(sha256sum "$CERTS/issuing-ca-2.der" | cut -d ' ' -f 1)
t0=$(aia new-target-id) t1=$(aia new-target-id) t2=$(aia new-target-id) t3=$(aia new-target-id)
cat >"$T/smoke/config.json" <<JSON
{
  "version": 1,
  "certificates": {
    "$root": { "label": "Example Root CA" },
    "$ca1": { "label": "Example Issuing CA 01" },
    "$ca2": { "label": "Example Issuing CA 02" }
  },
  "targets": {
    "$t0": { "issuer": "$root", "kind": "full", "label": "Example Root CA" },
    "$t1": { "issuer": "$ca1", "kind": "full", "label": "Example Issuing CA 01" },
    "$t2": { "issuer": "$ca1", "kind": "delta", "label": "Example Issuing CA 01 (delta)" },
    "$t3": { "issuer": "$ca2", "kind": "full", "label": "Example Issuing CA 02" }
  },
  "paths": {
    "/ca/root-ca.crt": { "certificate": "$root" },
    "/ca/issuing-ca-1.crt": { "certificate": "$ca1" },
    "/ca/issuing-ca-2.crt": { "certificate": "$ca2" },
    "/crl/root-ca.crl": { "target": "$t0" },
    "/crl/issuing-ca-1.crl": { "target": "$t1" },
    "/dcrl/issuing-ca-1.crl": { "target": "$t2" },
    "/crl/issuing-ca-2.crl": { "target": "$t3" }
  }
}
JSON
# docker cp keeps the modes, and uid 1000 must be able to read them in the container.
chmod 755 "$T/smoke"
chmod 644 "$T/smoke"/*
docker cp "$T/smoke/." "$NAME:/tmp/aia-smoke"

aia_check "aia config validate" 'valid offline' config validate /tmp/aia-smoke/config.json
aia_check "aia import" '3 created, 0 unchanged, 0 failed' \
  import /tmp/aia-smoke/root-ca.der /tmp/aia-smoke/chain.pem
aia_check "aia config apply" '^applied /tmp/aia-smoke/config.json \(ETag "[0-9a-f]{64}"\)$' \
  config apply /tmp/aia-smoke/config.json
health healthy
aia_check "aia health" '^healthy: ' health
aia_check "aia import again" '0 created, 3 unchanged, 0 failed' \
  import /tmp/aia-smoke/root-ca.der /tmp/aia-smoke/chain.pem

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
