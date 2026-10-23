#!/usr/bin/env bash
# HTTP smoke test of a running aia-cdp server, the same on every runtime (scripts/worker-smoke.ts,
# scripts/docker-smoke.sh, a dev server after `pnpm run seed:dev`):
#
#   bash scripts/smoke.sh BASE_URL          e.g. http://127.0.0.1:8787
#
# The server must serve tests/fixtures/pki/certs/root-ca.der under /ca/root-ca.crt and a full CRL
# target of that CA under /crl/root-ca.crl. Checks health, the certificate download and its 304, a
# raw upload of crls/root-ca/full-01.der (with $AIA_UPLOAD_TOKEN when set) and its download, the
# API reads, the UI, and that nothing outside the static root is served. Exits 1 if a check fails.
# Needs bash, curl and cmp.
set -uo pipefail

if ! [[ $# -eq 1 && $1 =~ ^https?://[^/]+/?$ ]]; then
  echo "usage: bash scripts/smoke.sh BASE_URL" >&2
  exit 2
fi
BASE=${1%/}
PKI=$(cd "$(dirname "${BASH_SOURCE[0]}")/../tests/fixtures/pki" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/aia-cdp-smoke.XXXXXX")
trap 'rm -rf "$T"' EXIT
failed=0

# request METHOD PATH [CURL_ARGS...]: the status in CODE, headers in $T/h, body in $T/b.
request() {
  REQ="$1 $2"
  CODE=$(curl -sS --max-time 10 -X "$1" -D "$T/h" -o "$T/b" -w '%{http_code}' "${@:3}" "$BASE$2") ||
    CODE=000
}
# header NAME: the value of the last NAME header of the response ("" if none).
header() {
  tr -d '\r' <"$T/h" | awk -v n="$1:" 'tolower(substr($0, 1, length(n))) == tolower(n) {
    v = substr($0, length(n) + 1); sub(/^[ \t]+/, "", v) } END { print v }'
}
# report STATUS: ok when the checks of the last request passed (STATUS 0), else FAIL.
report() {
  if (($1 == 0)); then echo "ok    $CODE $REQ"; else
    echo "FAIL  $CODE $REQ: $(head -c 300 "$T/b" 2>/dev/null | tr '\n' ' ')"
    failed=$((failed + 1))
  fi
}
# download PATH TYPE FIXTURE: 200 with that Content-Type and the fixture's bytes.
download() {
  request GET "$1"
  [[ $CODE == 200 && $(header Content-Type) == "$2"* ]] && cmp -s "$T/b" "$PKI/$3"
  report $?
}

request GET /api/v1/health
[[ $CODE == 200 ]] && grep -qE '"status": ?"healthy"' "$T/b"
report $?
[[ $CODE != 000 ]] || { echo "smoke: cannot reach $BASE" >&2; exit 1; }

download /ca/root-ca.crt application/pkix-cert certs/root-ca.der
etag=$(header ETag)
request GET /ca/root-ca.crt -H "If-None-Match: $etag"
[[ $CODE == 304 && -n $etag ]]
report $?

# The token goes in a header file, never on a command line.
: >"$T/auth"
[[ -z ${AIA_UPLOAD_TOKEN-} ]] || echo "Authorization: Bearer $AIA_UPLOAD_TOKEN" >"$T/auth"
request POST /api/v1/crls -H "@$T/auth" -H 'Content-Type: application/pkix-crl' \
  --data-binary "@$PKI/crls/root-ca/full-01.der"
target=$(grep -oE '"target": ?"[0-9a-f-]{36}"' "$T/b" | grep -oE '[0-9a-f-]{36}')
issuer=$(grep -oE '"issuer": ?"[0-9a-f]{64}"' "$T/b" | grep -oE '[0-9a-f]{64}')
[[ $CODE =~ ^20[01]$ && -n $target && -n $issuer ]] &&
  grep -qE '"outcome": ?"(created|unchanged)"' "$T/b"
report $?
download /crl/root-ca.crl application/pkix-crl crls/root-ca/full-01.der

for path in /api/v1/certificates "/api/v1/certificates/$issuer" /api/v1/crls \
  "/api/v1/crls/$target" /api/v1/stats /api/v1/openapi.json; do
  request GET "$path"
  [[ $CODE == 200 && $(header Content-Type) == application/json* ]]
  report $?
done

request GET /
script=$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$T/b" | head -n 1)
[[ $CODE == 200 && $(header Content-Type) == text/html* && -n $script ]]
report $?
request GET "${script:-/assets/missing.js}"
[[ $CODE == 200 ]]
report $?
# A download prefix answers CryptoAPI clients in plain text, never with the UI.
request GET /crl/missing.crl
[[ $CODE == 404 && $(header Content-Type) == text/plain* ]]
report $?

# The static root is dist/web on the host and /app/dist/web in the image: two levels up is the real
# package.json, ten reach /etc/passwd. The Worker's assets layer may answer 307 instead.
up=..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f
for path in /../package.json /%2e%2e/package.json /assets/..%2f..%2fpackage.json \
  /../../../../../../../../../../etc/passwd "/assets/${up}etc%2fpasswd"; do
  request GET "$path" --path-as-is
  [[ $CODE != 5* && $CODE != 000 ]] && ! grep -qE '"devEngines"|root:x:0:0' "$T/b"
  report $?
done

echo "smoke: $failed failed against $BASE"
((failed == 0))
