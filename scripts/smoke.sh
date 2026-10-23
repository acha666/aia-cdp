#!/usr/bin/env bash
# Runtime-independent HTTP smoke test of a running aia-cdp server: the Node runtime, `wrangler dev`,
# wrangler's createTestHarness and the Docker image all answer it the same way.
#
#   bash scripts/smoke.sh BASE_URL          e.g. http://127.0.0.1:8787
#
# Prints one line per check and exits 1 if any check fails (2 on usage errors). Needs bash and
# curl. The server may or may not be configured (health "healthy" or "degraded"); the runners
# (node-smoke.sh, worker-smoke.ts, docker-smoke.sh) assert that state themselves. /index.html is
# deliberately not requested: Workers' html_handling answers 307 there, Node 200.
set -uo pipefail

usage() {
  echo "usage: bash scripts/smoke.sh BASE_URL" >&2
  exit 2
}
[[ $# -eq 1 && $1 =~ ^https?://[^/]+/?$ ]] || usage
BASE=${1%/}
command -v curl >/dev/null || {
  echo "smoke: curl is required" >&2
  exit 2
}

T=$(mktemp -d "${TMPDIR:-/tmp}/aia-cdp-smoke.XXXXXX")
trap 'rm -rf "$T"' EXIT

passed=0 failed=0 REQ='' CODE=''
errors=()

# request METHOD PATH [CURL_ARGS...]: status in CODE, headers in $T/h, body in $T/b.
# HEAD uses --head (curl then stores the headers in $T/b as well; HEAD bodies are checked by
# head_has_no_body).
request() {
  local method=$1 path=$2
  shift 2
  REQ="$method $path${*:+ ($*)}"
  : >"$T/h"
  : >"$T/b"
  local how=(-X "$method")
  if [[ $method == HEAD ]]; then how=(--head); fi
  if ! CODE=$(curl -sS --max-time 10 "${how[@]}" -D "$T/h" -o "$T/b" -w '%{http_code}' \
    "$@" "$BASE$path" 2>"$T/e"); then
    CODE=000
    errors+=("curl: $(tr '\n' ' ' <"$T/e")")
  fi
}

# header NAME: value of the last NAME header of the response; status 1 when absent.
header() {
  tr -d '\r' <"$T/h" | awk -v n="$1" '
    { i = index($0, ":") }
    i > 1 && tolower(substr($0, 1, i - 1)) == tolower(n) {
      v = substr($0, i + 1); sub(/^[ \t]+/, "", v); found = 1
    }
    END { if (found) print v; exit !found }'
}

# ERE for one comma-separated directive of a header value, e.g. $(token no-store).
token() { printf '(^|[ ,])%s($|[ ,])' "$1"; }

want_status() { [[ $CODE == "$1" ]] || errors+=("status $CODE, want $1"); }
want_not_5xx() { [[ $CODE != 5* && $CODE != 000 ]] || errors+=("status $CODE"); }
want_header() { # NAME ERE
  local v
  if ! v=$(header "$1"); then
    errors+=("no $1 header")
  elif ! [[ $v =~ $2 ]]; then
    errors+=("$1: \"$v\" does not match /$2/")
  fi
}
want_no_header() {
  local v
  if v=$(header "$1"); then errors+=("unexpected $1: \"$v\""); fi
}
want_not_2xx() { [[ $CODE != 2* ]] || errors+=("status $CODE, want a non-2xx answer"); }
want_not_html() {
  local v
  if v=$(header Content-Type) && [[ $v =~ $HTML ]]; then errors+=("Content-Type: \"$v\" is HTML"); fi
}
want_body() { grep -qE -- "$1" "$T/b" || errors+=("body does not match /$1/"); }
want_body_without() { if grep -qF -- "$1" "$T/b"; then errors+=("body contains $1"); fi; }
want_security_headers() {
  want_header X-Content-Type-Options '^nosniff$'
  want_no_header Strict-Transport-Security
}

# head_has_no_body PATH: send a raw HTTP/1.1 HEAD and require that nothing follows the header
# block (curl --head never reads a body, so it cannot tell). Only for http:// base URLs.
head_has_no_body() {
  local hostport=${BASE#http://} host port line
  if [[ $BASE != http://* ]]; then
    echo "      (raw HEAD body check skipped for $BASE)"
    return
  fi
  [[ $CODE != 000 ]] || return # unreachable; /dev/tcp has no connect timeout
  if [[ $hostport =~ ^\[([^]]+)\](:([0-9]+))?$ || $hostport =~ ^([^:]+)(:([0-9]+))?$ ]]; then
    host=${BASH_REMATCH[1]} port=${BASH_REMATCH[3]:-80}
  else
    errors+=("cannot parse host and port of $BASE")
    return
  fi
  if ! exec 3<>"/dev/tcp/$host/$port"; then
    errors+=("raw HEAD: cannot connect to $host:$port")
    return
  fi
  printf 'HEAD %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$1" "$hostport" >&3
  while IFS= read -r -t 10 line <&3 || [[ -n $line ]]; do printf '%s\n' "$line"; done >"$T/raw"
  exec 3<&-
  local status body_bytes
  status=$(head -n 1 "$T/raw" | tr -d '\r')
  body_bytes=$(tr -d '\r' <"$T/raw" | awk 'body { n += length($0) + 1 } !body && $0 == "" { body = 1 } END { print n + 0 }')
  [[ $status =~ ^HTTP/1\.[01]\ 200 ]] || errors+=("raw HEAD status line: $status")
  [[ $body_bytes == 0 ]] || errors+=("HEAD response carried a body ($body_bytes bytes)")
}

report() {
  if ((${#errors[@]} == 0)); then
    passed=$((passed + 1))
    printf 'ok    %s %s\n' "$CODE" "$REQ"
  else
    failed=$((failed + 1))
    printf 'FAIL  %s %s\n' "$CODE" "$REQ"
    printf '        - %s\n' "${errors[@]}"
  fi
  errors=()
}

JSON='^application/json'
TEXT='^text/plain'
HTML='^text/html'
HEX64=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
UUID=7f9c2ba4-e88f-41ee-8c90-0242ac120002

# --- API ----------------------------------------------------------------------------------------
request GET /api/v1/health
want_status 200
want_header Content-Type "$JSON"
want_header Cache-Control "$(token no-store)"
want_security_headers
want_body '"status": ?"(healthy|degraded)"'
if [[ $CODE == 000 ]]; then
  report
  echo "smoke: cannot reach $BASE" >&2
  exit 1
fi
report

request HEAD /api/v1/health
want_status 200
want_header Content-Type "$JSON"
head_has_no_body /api/v1/health
report

request POST /api/v1/health
want_status 405
want_header Allow '^GET, HEAD$'
want_header Content-Type "$JSON"
want_body '"code": ?"method_not_allowed"'
report

for path in /api/v1/missing /api; do
  request GET "$path"
  want_status 404
  want_header Content-Type "$JSON"
  want_header Cache-Control "$(token no-store)"
  want_body '"code": ?"not_found"'
  report
done

request GET /api/v1/openapi.json
want_status 200
want_header Content-Type "$JSON"
want_header Cache-Control "$(token max-age=300)"
want_body '"openapi": ?"3\.1\.0"'
want_body '"/api/v1/health"'
report

# --- download prefixes: plain-text 404 for CryptoAPI clients, never the UI ----------------------
for path in /ca/x.crt /crl/missing.crl /dcrl/x.crl; do
  request GET "$path"
  want_status 404
  want_header Content-Type "$TEXT"
  want_header Cache-Control "$(token no-store)"
  want_security_headers
  want_body '^Not Found$'
  report
done

# --- UI -----------------------------------------------------------------------------------------
request GET /
want_status 200
want_header Content-Type "$HTML"
want_header Cache-Control '^no-cache$'
want_security_headers
want_body '<div id="app">'
script=$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$T/b" | head -n 1 || true)
[[ -n $script ]] || errors+=("no hashed /assets/*.js in index.html")
report

for path in "/certificates/$HEX64" "/crls/$UUID"; do
  for method in GET HEAD; do
    request "$method" "$path"
    want_status 200
    want_header Content-Type "$HTML"
    want_header Cache-Control '^no-cache$'
    report
  done
done

if [[ -n $script ]]; then
  request GET "$script"
  want_status 200
  want_header Content-Type 'javascript'
  want_header Cache-Control "$(token max-age=31536000)"
  want_header Cache-Control "$(token immutable)"
  report
fi

request GET /assets/missing-0000.js
want_status 404
want_header Content-Type "$TEXT"
report

request POST /crls/x
want_status 404
report

# --- traversal: nothing outside the static root -------------------------------------------------
# The static root is dist/web on the host and /app/dist/web in the image, so two levels up is the
# real package.json in both, and ten levels reach /etc/passwd from either. A handler that decoded
# %2f (or let `..` through) would serve them; the Worker's assets layer may answer 307 instead.
up=..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f
for path in /../package.json /%2e%2e/package.json /assets/..%2f..%2fpackage.json \
  /..%2f..%2fpackage.json /%2e%2e%2f%2e%2e%2fpackage.json /assets/..%2f..%2f..%2fpackage.json \
  /../../../../../../../../../../etc/passwd "/${up}etc%2fpasswd" "/assets/${up}etc%2fpasswd"; do
  request GET "$path" --path-as-is
  want_not_5xx
  want_body_without '"packageManager"'
  want_body_without 'root:x:0:0'
  report
done

printf 'smoke: %d passed, %d failed against %s\n' "$passed" "$failed" "$BASE"
((failed == 0))
