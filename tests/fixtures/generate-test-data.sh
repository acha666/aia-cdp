#!/usr/bin/env bash
# Generate PKI test fixtures for aia-cdp: CA certificates, one CRL per
# publish outcome, and malformed inputs.
#
#   bash tests/fixtures/generate-test-data.sh        (pnpm run fixtures)
#
# Regenerates tests/fixtures/pki/ (next to this script) in full, with public
# material only:
#   certs/<name>.der|.pem       CA and leaf certificates
#   crls/<issuer>/<case>.der    one CRL per test case (plus a few .pem variants)
#   invalid/                    inputs that must be rejected as invalid_crl
#   manifest.json               declared properties and expected outcomes
#
# The tree is staged next to itself and swapped in by rename, so an
# interrupted run leaves the previous tree in place.
#
# Private keys, CSRs and CA databases live in a mktemp work directory
# outside the tree that is deleted on exit; every generation uses fresh keys.
# Dates, serial numbers and CRL numbers are fixed below, so only
# key-dependent values change between runs (SKI/AKI, signatures, file
# digests, fingerprints, ECDSA signature lengths). Tests take those from the
# files or manifest.json, never from literals.
#
# Needs bash, OpenSSL >= 3.0 (not LibreSSL; OPENSSL=/path overrides) and
# od/awk/sed. KEEP_WORK=1 keeps the work directory (with keys) for debugging.
set -euo pipefail
export LC_ALL=C
OPENSSL=${OPENSSL:-openssl}

die() { printf 'generate-test-data: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || die "usage: generate-test-data.sh (no arguments; writes tests/fixtures/pki)"

OUT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pki

version=$("$OPENSSL" version 2>/dev/null) || die "cannot run '$OPENSSL'; set OPENSSL=/path/to/openssl (OpenSSL >= 3.0)"
if ! [[ $version =~ ^OpenSSL\ ([0-9]+)\. && ${BASH_REMATCH[1]} -ge 3 ]]; then
  die "need OpenSSL >= 3.0 (not LibreSSL), found: $version"
fi

sha256() { "$OPENSSL" dgst -sha256 -r "$1" | cut -d' ' -f1; }

WORK='' STAGE=''
cleanup() {
  if [[ -n $STAGE ]]; then rm -rf "$STAGE"; fi
  if [[ -z $WORK ]]; then return; fi
  if [[ ${KEEP_WORK-} == 1 ]]; then
    echo "work directory kept (contains private keys): $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT
WORK=$(mktemp -d "${TMPDIR:-/tmp}/aia-cdp-fixtures.XXXXXX")
STAGE=$(mktemp -d "$OUT.tmp.XXXXXX")
CNF=$WORK/openssl.cnf
mkdir -p "$WORK/keys" "$WORK/req" "$WORK/certs" "$STAGE/certs" "$STAGE/crls" "$STAGE/invalid"

# --- OpenSSL configuration -------------------------------------------------
# Static text; per-call values come from the environment ($ENV::NAME).
cat >"$CNF" <<'EOF'
# aia-cdp fixture CA configuration. Every $ENV:: variable below must be set
# for every openssl command that loads this file (they expand at load time).

[ ca ]
default_ca = ca_default

[ ca_default ]
dir             = $ENV::CA_DIR
database        = $dir/index.txt
new_certs_dir   = $dir/newcerts
serial          = $dir/serial
crlnumber       = $dir/crlnumber
certificate     = $dir/cert.pem
private_key     = $dir/key.pem
default_md      = default
policy          = policy_any
preserve        = yes
email_in_dn     = no
unique_subject  = no
copy_extensions = none
crl_extensions  = crl_ext

# No crlnumber file: CRLs carry no CRL Number extension.
[ ca_no_number ]
dir             = $ENV::CA_DIR
database        = $dir/index.txt
new_certs_dir   = $dir/newcerts
serial          = $dir/serial
certificate     = $dir/cert.pem
private_key     = $dir/key.pem
default_md      = default
policy          = policy_any
crl_extensions  = crl_ext

# No crlnumber and no crl_extensions: no AKI, no CRL Number. The CRL is
# still v2 when entries carry reason codes.
[ ca_no_extensions ]
dir             = $ENV::CA_DIR
database        = $dir/index.txt
new_certs_dir   = $dir/newcerts
serial          = $dir/serial
certificate     = $dir/cert.pem
private_key     = $dir/key.pem
default_md      = default
policy          = policy_any

[ policy_any ]
countryName            = optional
stateOrProvinceName    = optional
localityName           = optional
organizationName       = optional
organizationalUnitName = optional
commonName             = supplied

[ req ]
distinguished_name = req_dn
string_mask        = $ENV::STRING_MASK

[ req_dn ]

# --- certificate extensions ---

[ ext_root ]
basicConstraints     = critical, CA:TRUE
keyUsage             = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash

# Shape of the AD CS "SubCA" template certificates on pki.acha.top.
[ ext_issuing ]
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always
basicConstraints       = critical, CA:TRUE, pathlen:0
keyUsage               = critical, keyCertSign, cRLSign
authorityInfoAccess    = caIssuers;URI:http://pki.example.test/ca/root-ca.crt
crlDistributionPoints  = URI:http://pki.example.test/crl/root-ca.crl
# Microsoft CA Version V0.0, Certificate Template Name "SubCA" (BMPString)
1.3.6.1.4.1.311.21.1   = ASN1:INTEGER:0
1.3.6.1.4.1.311.20.2   = ASN1:BMPSTRING:SubCA

# AD CS renewal with the same key: CA Version V1.0 plus Previous CA
# Certificate Hash (SHA-1 of the previous CA certificate).
[ ext_issuing_renewed ]
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always
basicConstraints       = critical, CA:TRUE, pathlen:0
keyUsage               = critical, keyCertSign, cRLSign
authorityInfoAccess    = caIssuers;URI:http://pki.example.test/ca/root-ca.crt
crlDistributionPoints  = URI:http://pki.example.test/crl/root-ca.crl
1.3.6.1.4.1.311.21.1   = ASN1:INTEGER:1
1.3.6.1.4.1.311.21.2   = ASN1:FORMAT:HEX,OCTETSTRING:$ENV::PREV_CA_HASH
1.3.6.1.4.1.311.20.2   = ASN1:BMPSTRING:SubCA

[ ext_self_ca ]
basicConstraints     = critical, CA:TRUE
keyUsage             = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash

[ ext_leaf_full ]
basicConstraints       = critical, CA:FALSE
keyUsage               = critical, digitalSignature, keyAgreement
extendedKeyUsage       = serverAuth, clientAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid
subjectAltName         = @san_leaf_full
crlDistributionPoints  = URI:http://pki.example.test/crl/issuing-ca-1.crl
freshestCRL            = URI:http://pki.example.test/dcrl/issuing-ca-1.crl
authorityInfoAccess    = caIssuers;URI:http://pki.example.test/ca/issuing-ca-1.crt, OCSP;URI:http://ocsp.example.test/
certificatePolicies    = 2.23.140.1.2.1

[ san_leaf_full ]
DNS.1       = leaf.example.test
IP.1        = 192.0.2.10
IP.2        = 2001:db8::10
URI.1       = https://leaf.example.test/
email.1     = leaf@example.test
otherName.1 = 1.3.6.1.4.1.311.20.2.3;UTF8:leaf@example.test

[ ext_leaf_min ]
basicConstraints       = critical, CA:FALSE
subjectKeyIdentifier   = none
authorityKeyIdentifier = none

[ ext_leaf ]
basicConstraints       = critical, CA:FALSE
keyUsage               = critical, digitalSignature
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid

# --- CRL extensions (openssl ca adds CRL Number itself, last) ---

# Plain OpenSSL CA, like the live offline root: AKI + CRL Number.
[ crl_ext ]
authorityKeyIdentifier = keyid:always

[ crl_ext_delta ]
authorityKeyIdentifier = keyid:always
2.5.29.27              = critical, ASN1:INTEGER:$ENV::BASE_CRL_NUMBER

# 1.3.6.1.4.1.32473 is the IANA example enterprise number (RFC 5612).
[ crl_ext_unknown_critical ]
authorityKeyIdentifier = keyid:always
1.3.6.1.4.1.32473.1    = critical, ASN1:UTF8String:aia-cdp fixture unknown critical extension

[ crl_ext_unknown_noncritical ]
authorityKeyIdentifier = keyid:always
1.3.6.1.4.1.32473.2    = ASN1:UTF8String:aia-cdp fixture unknown non-critical extension

# Scoped CRL: critical IDP limited to end-entity certificates.
[ crl_ext_idp_scoped ]
authorityKeyIdentifier   = keyid:always
issuingDistributionPoint = critical, @idp_scoped

[ idp_scoped ]
fullname = URI:http://pki.example.test/crl/issuing-ca-1-users.crl
onlyuser = TRUE

# Critical IDP that only names the distribution point: what AD CS emits when
# "Include in the IDP extension of issued CRLs" is ticked for a CDP.
[ crl_ext_idp_dp_only ]
authorityKeyIdentifier   = keyid:always
issuingDistributionPoint = critical, @idp_dp_only

[ idp_dp_only ]
fullname = URI:http://pki.example.test/crl/issuing-ca-1.crl

# AKI naming another CA's key (FORGED_KEYID) instead of the signer's.
[ crl_ext_forged_aki ]
2.5.29.35 = ASN1:SEQUENCE:forged_aki

[ forged_aki ]
keyid = IMPLICIT:0,FORMAT:HEX,OCTETSTRING:$ENV::FORGED_KEYID

# Extension set of the live AD CS full CRLs: AKI, CA Version, CRL Number,
# Next CRL Publish (UTCTime), Freshest CRL (http + ldap), CRL Self CDP (ldap).
[ crl_ext_adcs_full ]
authorityKeyIdentifier = keyid:always
1.3.6.1.4.1.311.21.1   = ASN1:INTEGER:0
1.3.6.1.4.1.311.21.4   = ASN1:UTCTIME:$ENV::NEXT_PUBLISH
freshestCRL            = adcs_freshest
1.3.6.1.4.1.311.21.14  = ASN1:SEQUENCE:adcs_self_cdp

[ adcs_freshest ]
fullname = @adcs_freshest_names

[ adcs_freshest_names ]
URI.0 = http://pki.example.test/dcrl/issuing-ca-1.crl
URI.1 = ldap:///CN=Example%20Issuing%20CA%2001,CN=ca01,CN=CDP,CN=Public%20Key%20Services,CN=Services,CN=Configuration,DC=example,DC=test?deltaRevocationList?base?objectClass=cRLDistributionPoint

# CRLDistributionPoints ::= SEQUENCE OF DistributionPoint; distributionPoint
# [0] EXPLICIT (a CHOICE), fullName [0] IMPLICIT, URI [6] IMPLICIT.
[ adcs_self_cdp ]
dp = SEQUENCE:adcs_self_cdp_dp

[ adcs_self_cdp_dp ]
name = EXPLICIT:0,IMPLICIT:0,SEQUENCE:adcs_self_cdp_names

[ adcs_self_cdp_names ]
ldap = IMPLICIT:6,IA5STRING:ldap:///CN=Example%20Issuing%20CA%2001,CN=ca01,CN=CDP,CN=Public%20Key%20Services,CN=Services,CN=Configuration,DC=example,DC=test?certificateRevocationList?base?objectClass=cRLDistributionPoint

# Extension set of the live AD CS delta CRLs.
[ crl_ext_adcs_delta ]
authorityKeyIdentifier = keyid:always
1.3.6.1.4.1.311.21.1   = ASN1:INTEGER:0
1.3.6.1.4.1.311.21.4   = ASN1:UTCTIME:$ENV::NEXT_PUBLISH
2.5.29.27              = critical, ASN1:INTEGER:$ENV::BASE_CRL_NUMBER
EOF

# Defaults for every $ENV:: variable above; calls override what they use.
export CA_DIR=$WORK/ca/none STRING_MASK=pkix BASE_CRL_NUMBER=0 \
  NEXT_PUBLISH=260101000000Z FORGED_KEYID=00 PREV_CA_HASH=00

# --- helpers ----------------------------------------------------------------
ossl() {
  if ! "$OPENSSL" "$@" >"$WORK/openssl.log" 2>&1; then
    cat "$WORK/openssl.log" >&2
    die "openssl $1 failed"
  fi
}

# openssl reads serial/crlnumber files as hex with an even number of digits.
even_hex() {
  local h
  h=$(printf '%X' "$1")
  ((${#h} % 2 == 0)) || h=0$h
  printf '%s' "$h"
}
iso() { printf '%s-%s-%sT%s:%s:%sZ' "${1:0:4}" "${1:4:2}" "${1:6:2}" "${1:8:2}" "${1:10:2}" "${1:12:2}"; }
md_of() { case $1 in root-ca) echo sha384 ;; ed25519-ca | ed448-ca) echo default ;; *) echo sha256 ;; esac; }
ski() { "$OPENSSL" x509 -in "$WORK/certs/$1.pem" -noout -ext subjectKeyIdentifier | sed -n '2s/[ :]//gp'; }

genkey() { # NAME rsa|p256|p384|ed25519|ed448
  local out=$WORK/keys/$1.pem
  case $2 in
    rsa) ossl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$out" ;;
    p256 | p384) ossl genpkey -algorithm EC -pkeyopt "ec_paramgen_curve:P-${2#p}" -pkeyopt ec_param_enc:named_curve -out "$out" ;;
    ed25519 | ed448) ossl genpkey -algorithm "$2" -out "$out" ;;
  esac
}

ca_init() { # NAME FIRST_SERIAL_HEX
  mkdir -p "$WORK/ca/$1/newcerts"
  : >"$WORK/ca/$1/index.txt"
  printf '%s\n' "$2" >"$WORK/ca/$1/serial"
}
ca_ready() { # NAME: install the issued certificate and key as a CA
  cp "$WORK/keys/$1.pem" "$WORK/ca/$1/key.pem"
  cp "$WORK/certs/$1.pem" "$WORK/ca/$1/cert.pem"
}

# issue NAME ISSUER|self EXTENSIONS NOT_BEFORE NOT_AFTER SUBJECT [STRING_MASK]
issue() {
  local name=$1 issuer=$2 ext=$3 start=$4 end=$5 subject=$6 mask=${7:-pkix}
  local key=$WORK/keys/$name.pem req=$WORK/req/$name.pem cert=$WORK/certs/$name.pem
  STRING_MASK=$mask ossl req -new -utf8 -config "$CNF" -key "$key" -subj "$subject" -out "$req"
  local -a sign=(-md "$(md_of "$issuer")")
  [[ $issuer == self ]] && issuer=$name && sign=(-md "$(md_of "$name")" -selfsign -keyfile "$key")
  CA_DIR=$WORK/ca/$issuer ossl ca -batch -notext -config "$CNF" "${sign[@]}" \
    -extensions "$ext" -startdate "$start" -enddate "$end" -in "$req" -out "$cert"
  ossl x509 -in "$cert" -outform DER -out "$STAGE/certs/$name.der"
  cp "$cert" "$STAGE/certs/$name.pem"
}

revoke() { # ISSUER SERIAL_HEX REVOCATION_FIELD (index.txt syntax)
  local db=$WORK/ca/$1/index.txt
  awk -F'\t' -v OFS='\t' -v serial="$2" -v info="$3" \
    '$4 == serial { $1 = "R"; $3 = info; hit = 1 } { print } END { if (!hit) exit 1 }' \
    "$db" >"$db.new" || die "revoke: serial $2 not in the $1 database"
  mv "$db.new" "$db"
}

# crl SIGNER NUMBER THIS_UPDATE NEXT_UPDATE EXTENSIONS OUT [openssl ca args]
#   NUMBER: decimal CRL number, "none" (no CRL Number extension) or "noext"
#   (no CRL extensions at all). OUT is relative to crls/.
crl() {
  local signer=$1 number=$2 this=$3 next=$4 ext=$5 out=$STAGE/crls/$6
  shift 6
  local dir=$WORK/ca/$signer name=ca_default
  local -a ext_args=(-crlexts "$ext")
  case $number in
    none) name=ca_no_number ;;
    noext) name=ca_no_extensions ext_args=() ;;
    *) printf '%s\n' "$(even_hex "$number")" >"$dir/crlnumber" ;;
  esac
  mkdir -p "$(dirname "$out")"
  CA_DIR=$dir ossl ca -batch -gencrl -config "$CNF" -name "$name" -md "$(md_of "$signer")" \
    -crl_lastupdate "$this" -crl_nextupdate "$next" ${ext_args[@]+"${ext_args[@]}"} "$@" -out "$WORK/crl.pem"
  ossl crl -in "$WORK/crl.pem" -outform DER -out "$out"
}

# Byte strings are " xx xx ..." so that substring matches stay byte-aligned.
bytes_of() { od -An -v -tx1 | tr -s ' \n' '  ' | sed 's/ *$//'; }
file_bytes() { bytes_of <"$1"; }
text_bytes() { printf '%s' "$1" | bytes_of; }
write_bytes() { printf '%b' "${1// /\\x}"; }
nbytes() { echo $((${#1} / 3)); }
der_len() {
  local n=$1
  if ((n < 0x80)); then printf ' %02x' "$n"
  elif ((n < 0x100)); then printf ' 81 %02x' "$n"
  elif ((n < 0x10000)); then printf ' 82 %02x %02x' $((n >> 8)) $((n & 0xff))
  else die "der_len: $n bytes is too long"; fi
}
tlv() { printf ' %s%s%s' "$1" "$(der_len "$(nbytes "$2")")" "$2"; } # TAG_HEX CONTENT_BYTES
hdr() { # BYTES -> HDR (header length in characters), LEN (content bytes)
  local first=$((16#${1:4:2})) n i
  if ((first < 0x80)); then HDR=6 LEN=$first; return; fi
  n=$((first & 0x7f)) LEN=0
  for ((i = 0; i < n; i++)); do LEN=$((LEN * 256 + 16#${1:7+3*i:2})); done
  HDR=$((6 + 3 * n))
}

# resign FILE KEY DIGEST OLD NEW: replace exactly one byte-aligned OLD with
# NEW inside the TBSCertList of FILE, re-sign with KEY, rewrite FILE.
resign() {
  local file=$1 key=$2 md=$3 old=$4 new=$5 all body tbs rest alg stripped
  all=$(file_bytes "$file")
  hdr "$all" && body=${all:HDR:3*LEN}
  hdr "$body" && tbs=${body:HDR:3*LEN} rest=${body:HDR+3*LEN}
  hdr "$rest" && alg=${rest:0:HDR+3*LEN}
  stripped=${tbs//"$old"/}
  (($(nbytes "$tbs") - $(nbytes "$stripped") == $(nbytes "$old"))) ||
    die "resign: $file must contain the pattern exactly once"
  tbs=$(tlv 30 "${tbs/"$old"/"$new"}")
  write_bytes "$tbs" >"$WORK/tbs.der"
  ossl dgst "-$md" -sign "$key" -out "$WORK/sig.bin" "$WORK/tbs.der"
  write_bytes "$(tlv 30 "$tbs$alg$(tlv 03 " 00$(file_bytes "$WORK/sig.bin")")")" >"$file"
}

flip_last_byte() { # FILE: corrupt the last signature byte in place
  local b
  b=$(file_bytes "$1")
  write_bytes "${b:0:${#b}-2}$(printf '%02x' $((16#${b: -2} ^ 1)))" >"$1.tmp"
  mv "$1.tmp" "$1"
}

pem() { # DER LABEL OUT: armor the exact DER bytes
  { echo "-----BEGIN $2-----"; "$OPENSSL" base64 -e -in "$1"; echo "-----END $2-----"; } >"$3"
}

# --- manifest ---------------------------------------------------------------
CERTS=() CRLS=() INVALID=()
obj() { # KEY VALUE ...; a VALUE starting with "=" is emitted raw (number, null, bool)
  local out='' sep=''
  while (($#)); do
    case $2 in =*) out+="$sep\"$1\": ${2#=}" ;; *) out+="$sep\"$1\": \"$2\"" ;; esac
    sep=', '
    shift 2
  done
  printf '{%s}' "$out"
}
cert_entry() { # NAME ISSUER KEY NOT_BEFORE NOT_AFTER IMPORT ROLE
  local serial
  serial=$("$OPENSSL" x509 -in "$WORK/certs/$1.pem" -noout -serial | cut -d= -f2)
  CERTS+=("$(obj name "$1" der "certs/$1.der" pem "certs/$1.pem" issuer "$2" key "$3" \
    serial "$serial" notBefore "$(iso "$4")" notAfter "$(iso "$5")" import "=$6" \
    sha256 "$(sha256 "$STAGE/certs/$1.der")" role "$7")")
}
# crl_entry FILE ISSUER KIND NUMBER BASE THIS NEXT EXPECT NOTE [SIGNER]
#   NUMBER/BASE/NEXT may be "-" for absent. PUBLISH (environment, the
#   GeneralizedTime form of THIS) is the Next CRL Publish value the CRL
#   carries; unset for CRLs without that extension.
crl_entry() {
  local number=$4 base=$5 next=$7 signer=${10:-$2} publish='=null' revoked
  [[ $number =~ ^[0-9]+$ ]] || number='=null'
  [[ $base == - ]] && base='=null'
  if [[ $next == - ]]; then next='=null'; else next=$(iso "$next"); fi
  [[ -n ${PUBLISH-} ]] && publish=$(iso "$PUBLISH")
  revoked=$(grep -c '^R' "$WORK/ca/$signer/index.txt" || true)
  CRLS+=("$(obj file "crls/$1" issuer "$2" signer "$signer" kind "$3" crlNumber "$number" \
    baseCrlNumber "$base" thisUpdate "$(iso "$6")" nextUpdate "$next" nextPublish "$publish" \
    revoked "=$revoked" expect "$8" sha256 "$(sha256 "$STAGE/crls/$1")" note "$9")")
}
invalid_entry() { INVALID+=("$(obj file "invalid/$1" expect invalid_crl note "$2")"); }
emit() { # NAME ENTRY...
  local name=$1 sep=''
  shift
  printf '  "%s": [' "$name"
  for e in "$@"; do printf '%s\n    %s' "$sep" "$e" && sep=','; done
  printf '\n  ]'
}

# --- certificates -------------------------------------------------------------
ROOT_SUBJ="/C=US/O=Example PKI/CN=Example Root CA (ECC P-384)"
ICA1_SUBJ="/C=US/O=Example PKI/CN=Example Issuing CA 01 (RSA)"
ICA2_SUBJ="/C=US/O=Example PKI/CN=Example Issuing CA 02 (RSA)"
ICA1_RENAMED_SUBJ="/C=US/O=Example PKI/CN=Example Issuing CA 01 (RSA, renamed)"

genkey root-ca p384
ca_init root-ca 1000
issue root-ca self ext_root 20250101000000Z 20450101000000Z "$ROOT_SUBJ"
ca_ready root-ca

genkey issuing-ca-1 rsa
issue issuing-ca-1 root-ca ext_issuing 20250101000000Z 20350101000000Z "$ICA1_SUBJ"
ca_init issuing-ca-1 2000
ca_ready issuing-ca-1

genkey issuing-ca-2 rsa
issue issuing-ca-2 root-ca ext_issuing 20250101000000Z 20350101000000Z "$ICA2_SUBJ"
ca_init issuing-ca-2 3000
ca_ready issuing-ca-2

# Same key pair as issuing-ca-1, hence the same SKI.
cp "$WORK/keys/issuing-ca-1.pem" "$WORK/keys/issuing-ca-1-renewed.pem"
PREV_CA_HASH=$("$OPENSSL" dgst -sha1 -r "$STAGE/certs/issuing-ca-1.der" | cut -d' ' -f1) \
  issue issuing-ca-1-renewed root-ca ext_issuing_renewed 20251201000000Z 20351201000000Z "$ICA1_SUBJ"

# The same key pair (and SKI) once more, under another subject CN: the CRLs of
# issuing-ca-1 name an issuer this certificate is not, so only a check that
# ignores issuer names (C1) verifies them with it.
cp "$WORK/keys/issuing-ca-1.pem" "$WORK/keys/issuing-ca-1-renamed.pem"
issue issuing-ca-1-renamed root-ca ext_issuing 20250101000000Z 20350101000000Z "$ICA1_RENAMED_SUBJ"

# Rogue CA: own key, but the subject of issuing-ca-1.
genkey rogue-ca rsa
ca_init rogue-ca 4000
issue rogue-ca self ext_self_ca 20250101000000Z 20350101000000Z "$ICA1_SUBJ"
ca_ready rogue-ca

genkey ed25519-ca ed25519
ca_init ed25519-ca 5000
issue ed25519-ca self ext_self_ca 20250101000000Z 20350101000000Z "/C=US/O=Example PKI/CN=Example Ed25519 CA"
ca_ready ed25519-ca

genkey ed448-ca ed448
ca_init ed448-ca 6000
issue ed448-ca self ext_self_ca 20250101000000Z 20350101000000Z "/C=US/O=Example PKI/CN=Example Ed448 CA"
ca_ready ed448-ca

for leaf in leaf-full leaf-min leaf-revoked leaf-superseded leaf-hold; do genkey "$leaf" p256; done
issue leaf-full issuing-ca-1 ext_leaf_full 20251201000000Z 20261201000000Z \
  "/C=CH/L=Zürich/O=Example PKI/OU=测试/CN=leaf.example.test" utf8only
issue leaf-min issuing-ca-1 ext_leaf_min 20251201000000Z 20261201000000Z "/CN=Minimal Leaf"
issue leaf-revoked issuing-ca-1 ext_leaf 20251201000000Z 20261201000000Z "/C=US/O=Example PKI/CN=Revoked Leaf"
issue leaf-superseded issuing-ca-1 ext_leaf 20251201000000Z 20261201000000Z "/C=US/O=Example PKI/CN=Superseded Leaf"
issue leaf-hold issuing-ca-2 ext_leaf 20251201000000Z 20261201000000Z "/C=US/O=Example PKI/CN=On Hold Leaf"

cert_entry root-ca root-ca ec-p384 20250101000000Z 20450101000000Z true "offline root, ecdsa-with-SHA384 like the live root"
cert_entry issuing-ca-1 root-ca rsa-2048 20250101000000Z 20350101000000Z true "AD CS style issuing CA"
cert_entry issuing-ca-2 root-ca rsa-2048 20250101000000Z 20350101000000Z true "second issuing CA"
cert_entry issuing-ca-1-renewed root-ca rsa-2048 20251201000000Z 20351201000000Z false "same key and SKI as issuing-ca-1"
cert_entry issuing-ca-1-renamed root-ca rsa-2048 20250101000000Z 20350101000000Z false "same key and SKI as issuing-ca-1, other subject CN"
cert_entry rogue-ca rogue-ca rsa-2048 20250101000000Z 20350101000000Z false "never imported; subject equals issuing-ca-1"
cert_entry ed25519-ca ed25519-ca ed25519 20250101000000Z 20350101000000Z true "unsupported_algorithm issuer"
cert_entry ed448-ca ed448-ca ed448 20250101000000Z 20350101000000Z true "unsupported_algorithm issuer"
cert_entry leaf-full issuing-ca-1 ec-p256 20251201000000Z 20261201000000Z false "rich extensions, UTF8String subject"
cert_entry leaf-min issuing-ca-1 ec-p256 20251201000000Z 20261201000000Z false "basicConstraints only"
cert_entry leaf-revoked issuing-ca-1 ec-p256 20251201000000Z 20261201000000Z false "keyCompromise + invalidity date from full-01"
cert_entry leaf-superseded issuing-ca-1 ec-p256 20251201000000Z 20261201000000Z false "superseded from full-03"
cert_entry leaf-hold issuing-ca-2 ec-p256 20251201000000Z 20261201000000Z false "certificateHold + holdInstructionReject"

# --- CRLs ---------------------------------------------------------------------
I1=issuing-ca-1
revoke $I1 2002 '251215000000Z,keyTime,20251214000000Z'
revoke issuing-ca-2 3000 '251220000000Z,holdInstruction,holdInstructionReject'

crl root-ca 4096 20260101000000Z 20260701000000Z crl_ext root-ca/full-01.der
crl_entry root-ca/full-01.der root-ca full 4096 - 20260101000000Z 20260701000000Z created "ECDSA P-384"
crl root-ca 4097 20260102000000Z 20260702000000Z crl_ext root-ca/full-02.der
crl_entry root-ca/full-02.der root-ca full 4097 - 20260102000000Z 20260702000000Z created "updated after full-01"
crl root-ca 4097 20260102000000Z 20260702000000Z crl_ext root-ca/full-02-resigned.der
cmp -s "$STAGE/crls/root-ca/full-02.der" "$STAGE/crls/root-ca/full-02-resigned.der" &&
  die "re-signing with ECDSA produced identical bytes"
crl_entry root-ca/full-02-resigned.der root-ca full 4097 - 20260102000000Z 20260702000000Z created \
  "same TBS as full-02, new ECDSA signature: conflict against full-02"

# issuing-ca-1 numbers full and delta CRLs from one counter, as AD CS does.
crl $I1 1 20260101000000Z 20260108000000Z crl_ext $I1/full-01.der
crl_entry $I1/full-01.der $I1 full 1 - 20260101000000Z 20260108000000Z created "first full CRL"
BASE_CRL_NUMBER=1 crl $I1 2 20260101120000Z 20260103000000Z crl_ext_delta $I1/delta-01.der
crl_entry $I1/delta-01.der $I1 delta 2 1 20260101120000Z 20260103000000Z created "delta on base 1"
crl $I1 3 20260102000000Z 20260109000000Z crl_ext $I1/full-02.der
crl_entry $I1/full-02.der $I1 full 3 - 20260102000000Z 20260109000000Z created "updated after full-01"
crl $I1 3 20260102000000Z 20260109120000Z crl_ext $I1/full-02-conflict.der
crl_entry $I1/full-02-conflict.der $I1 full 3 - 20260102000000Z 20260109120000Z created \
  "same number and thisUpdate as full-02, other nextUpdate: conflict against full-02"
crl $I1 3 20260102060000Z 20260109060000Z crl_ext $I1/full-02-reissued.der
crl_entry $I1/full-02-reissued.der $I1 full 3 - 20260102060000Z 20260109060000Z created \
  "same number as full-02, later thisUpdate: updated against full-02"
BASE_CRL_NUMBER=3 crl $I1 4 20260102120000Z 20260104060000Z crl_ext_delta $I1/delta-02.der
crl_entry $I1/delta-02.der $I1 delta 4 3 20260102120000Z 20260104060000Z created "updated after delta-01"

revoke $I1 2003 '260102180000Z,superseded'
crl $I1 5 20260103000000Z 20260110000000Z crl_ext $I1/full-03.der
crl_entry $I1/full-03.der $I1 full 5 - 20260103000000Z 20260110000000Z created "two revoked entries"
crl $I1 6 20260102200000Z 20260109200000Z crl_ext $I1/full-04-older-time.der
crl_entry $I1/full-04-older-time.der $I1 full 6 - 20260102200000Z 20260109200000Z created \
  "higher number than full-03 but older thisUpdate: number wins, updated"
crl $I1 none 20260103060000Z 20260110060000Z crl_ext $I1/full-no-number.der
crl_entry $I1/full-no-number.der $I1 full - - 20260103060000Z 20260110060000Z created \
  "no CRL Number: non_orderable against any numbered current CRL and back"
crl $I1 noext 20260103060000Z 20260110060000Z - $I1/full-no-aki.der
crl_entry $I1/full-no-aki.der $I1 full - - 20260103060000Z 20260110060000Z issuer_not_found \
  "no CRL extensions at all (no AKI): details.reason missing_aki"

# Edge cases: numbers above the base sequence and thisUpdate after full-03,
# so each one would be "updated" if its check were missing.
EDGE=20260103120000Z EDGE_NEXT=20260110120000Z
crl $I1 10 $EDGE $EDGE_NEXT crl_ext $I1/full-broken-sig.der
flip_last_byte "$STAGE/crls/$I1/full-broken-sig.der"
crl_entry $I1/full-broken-sig.der $I1 full 10 - $EDGE $EDGE_NEXT invalid_signature "last signature byte flipped"
FORGED_KEYID=$(ski $I1) crl rogue-ca 11 $EDGE $EDGE_NEXT crl_ext_forged_aki $I1/full-forged-aki.der
crl_entry $I1/full-forged-aki.der $I1 full 11 - $EDGE $EDGE_NEXT invalid_signature \
  "issuer name and AKI of issuing-ca-1, signed by the rogue key" rogue-ca
crl $I1 12 $EDGE $EDGE_NEXT crl_ext_unknown_critical $I1/full-unknown-critical.der
crl_entry $I1/full-unknown-critical.der $I1 full 12 - $EDGE $EDGE_NEXT unknown_critical_extension "critical 1.3.6.1.4.1.32473.1"
crl $I1 13 $EDGE $EDGE_NEXT crl_ext_unknown_noncritical $I1/full-unknown-noncritical.der
crl_entry $I1/full-unknown-noncritical.der $I1 full 13 - $EDGE $EDGE_NEXT created "non-critical 1.3.6.1.4.1.32473.2 is kept"
crl $I1 14 $EDGE $EDGE_NEXT crl_ext_idp_scoped $I1/full-idp-scoped.der
crl_entry $I1/full-idp-scoped.der $I1 full 14 - $EDGE $EDGE_NEXT scoped_crl_unsupported "critical IDP, onlyContainsUserCerts"
crl $I1 15 $EDGE $EDGE_NEXT crl_ext_idp_dp_only $I1/full-idp-dp-only.der
crl_entry $I1/full-idp-dp-only.der $I1 full 15 - $EDGE $EDGE_NEXT created \
  "critical IDP naming only the DP (AD CS option): accepted (slice 4 owner answer 2)"
crl $I1 16 $EDGE $EDGE_NEXT crl_ext $I1/full-pss.der \
  -sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:digest -sigopt rsa_mgf1_md:sha256
crl_entry $I1/full-pss.der $I1 full 16 - $EDGE $EDGE_NEXT created "RSASSA-PSS SHA-256, MGF1 SHA-256, salt 32"
crl $I1 17 $EDGE $EDGE_NEXT crl_ext $I1/full-no-next-update.der
resign "$STAGE/crls/$I1/full-no-next-update.der" "$WORK/keys/$I1.pem" sha256 \
  " 17 0d$(text_bytes "${EDGE_NEXT:2}")" ""
crl_entry $I1/full-no-next-update.der $I1 full 17 - $EDGE - created "nextUpdate removed and re-signed: cache max-age 300 s"
crl $I1 18 $EDGE $EDGE_NEXT crl_ext $I1/full-bad-time.der
resign "$STAGE/crls/$I1/full-bad-time.der" "$WORK/keys/$I1.pem" sha256 \
  " 17 0d$(text_bytes "${EDGE:2}")" " 17 0b$(text_bytes "${EDGE:2:10}Z")"
crl_entry $I1/full-bad-time.der $I1 full 18 - $EDGE $EDGE_NEXT invalid_crl \
  "thisUpdate UTCTime without seconds, validly signed"
ADCS_FULL_PUBLISH=20260110120000Z ADCS_DELTA_PUBLISH=20260104180000Z
NEXT_PUBLISH=${ADCS_FULL_PUBLISH:2} crl $I1 19 20260103115000Z 20260111001000Z crl_ext_adcs_full $I1/full-adcs.der
PUBLISH=$ADCS_FULL_PUBLISH crl_entry $I1/full-adcs.der $I1 full 19 - 20260103115000Z 20260111001000Z created \
  "AD CS extension set: CA Version, Next CRL Publish, Freshest CRL, CRL Self CDP"
NEXT_PUBLISH=${ADCS_DELTA_PUBLISH:2} BASE_CRL_NUMBER=19 \
  crl $I1 20 20260103175000Z 20260105061000Z crl_ext_adcs_delta $I1/delta-adcs.der
PUBLISH=$ADCS_DELTA_PUBLISH crl_entry $I1/delta-adcs.der $I1 delta 20 19 20260103175000Z 20260105061000Z created \
  "AD CS delta extension set"
# SHA-1 signatures are accepted (slice 4 owner answer 1). The later -md wins.
crl $I1 21 $EDGE $EDGE_NEXT crl_ext $I1/full-sha1.der -md sha1
[[ $("$OPENSSL" crl -inform DER -in "$STAGE/crls/$I1/full-sha1.der" -noout -text) == \
  *'Signature Algorithm: sha1WithRSAEncryption'* ]] || die "full-sha1.der is not signed with SHA-1"
crl_entry $I1/full-sha1.der $I1 full 21 - $EDGE $EDGE_NEXT created "sha1WithRSAEncryption"
crl $I1 30 20990101000000Z 20990108000000Z crl_ext $I1/full-future.der
crl_entry $I1/full-future.der $I1 full 30 - 20990101000000Z 20990108000000Z not_yet_valid \
  "thisUpdate 2099 (GeneralizedTime): future for any clock"

crl issuing-ca-2 1 20260101000000Z 20260108000000Z crl_ext issuing-ca-2/full-01.der
crl_entry issuing-ca-2/full-01.der issuing-ca-2 full 1 - 20260101000000Z 20260108000000Z created "certificateHold entry"
BASE_CRL_NUMBER=1 crl issuing-ca-2 2 20260101120000Z 20260103000000Z crl_ext_delta issuing-ca-2/delta-01.der
crl_entry issuing-ca-2/delta-01.der issuing-ca-2 delta 2 1 20260101120000Z 20260103000000Z created "delta on base 1"
crl rogue-ca 1 20260101000000Z 20260108000000Z crl_ext rogue-ca/full-01.der
crl_entry rogue-ca/full-01.der rogue-ca full 1 - 20260101000000Z 20260108000000Z issuer_not_found \
  "AKI of a certificate that is never imported"
crl ed25519-ca 1 20260101000000Z 20260108000000Z crl_ext ed25519-ca/full-01.der
crl_entry ed25519-ca/full-01.der ed25519-ca full 1 - 20260101000000Z 20260108000000Z unsupported_algorithm "Ed25519 signature"
crl ed448-ca 1 20260101000000Z 20260108000000Z crl_ext ed448-ca/full-01.der
crl_entry ed448-ca/full-01.der ed448-ca full 1 - 20260101000000Z 20260108000000Z unsupported_algorithm "Ed448 signature"

C=$STAGE/crls
pem "$C/$I1/full-01.der" "X509 CRL" "$C/$I1/full-01.pem"
awk '{ printf "%s\r\n", $0 }' "$C/$I1/full-01.pem" >"$C/$I1/full-01.crlf.pem"
pem "$C/root-ca/full-01.der" "X509 CRL" "$C/root-ca/full-01.pem"

# --- malformed inputs ---------------------------------------------------------
V=$STAGE/invalid
printf 'This is not a CRL\n' >"$V/garbage.txt"
invalid_entry garbage.txt "text"
: >"$V/empty.bin"
invalid_entry empty.bin "zero bytes"
head -c 64 "$C/$I1/full-01.der" >"$V/truncated.der"
invalid_entry truncated.der "first 64 bytes of a DER CRL"
head -n 3 "$C/$I1/full-01.pem" >"$V/truncated.pem"
invalid_entry truncated.pem "PEM without its end line"
{ cat "$C/$I1/full-01.der"; printf '\0'; } >"$V/trailing-byte.der"
invalid_entry trailing-byte.der "valid CRL followed by one zero byte"
cp "$STAGE/certs/$I1.der" "$V/certificate.der"
invalid_entry certificate.der "a certificate, not a CRL"

# --- manifest, swap ---------------------------------------------------------
{
  printf '{\n  "version": 1,\n  "openssl": "%s",\n' "$version"
  printf '  "now": "2026-01-04T00:00:00Z",\n'
  emit certificates "${CERTS[@]}"
  printf ',\n'
  emit crls "${CRLS[@]}"
  printf ',\n'
  emit invalid "${INVALID[@]}"
  printf ',\n'
  cat <<'EOF'
  "scenarios": [
    {"current": null, "upload": "crls/issuing-ca-1/full-01.der", "outcome": "created"},
    {"current": "crls/issuing-ca-1/full-01.der", "upload": "crls/issuing-ca-1/full-01.der", "outcome": "unchanged"},
    {"current": "crls/issuing-ca-1/full-01.der", "upload": "crls/issuing-ca-1/full-01.pem", "outcome": "unchanged"},
    {"current": "crls/issuing-ca-1/full-01.der", "upload": "crls/issuing-ca-1/full-02.der", "outcome": "updated"},
    {"current": "crls/issuing-ca-1/full-02.der", "upload": "crls/issuing-ca-1/full-01.der", "outcome": "stale_crl"},
    {"current": "crls/issuing-ca-1/full-02.der", "upload": "crls/issuing-ca-1/full-02-conflict.der", "outcome": "conflict"},
    {"current": "crls/issuing-ca-1/full-02.der", "upload": "crls/issuing-ca-1/full-02-reissued.der", "outcome": "updated"},
    {"current": "crls/issuing-ca-1/full-02-reissued.der", "upload": "crls/issuing-ca-1/full-02.der", "outcome": "stale_crl"},
    {"current": "crls/issuing-ca-1/full-03.der", "upload": "crls/issuing-ca-1/full-04-older-time.der", "outcome": "updated"},
    {"current": "crls/issuing-ca-1/full-02.der", "upload": "crls/issuing-ca-1/full-no-number.der", "outcome": "non_orderable"},
    {"current": "crls/issuing-ca-1/full-no-number.der", "upload": "crls/issuing-ca-1/full-02.der", "outcome": "non_orderable"},
    {"current": "crls/issuing-ca-1/delta-01.der", "upload": "crls/issuing-ca-1/delta-02.der", "outcome": "updated"},
    {"current": "crls/issuing-ca-1/delta-02.der", "upload": "crls/issuing-ca-1/delta-01.der", "outcome": "stale_crl"},
    {"current": "crls/issuing-ca-1/delta-02.der", "upload": "crls/issuing-ca-1/delta-adcs.der", "outcome": "updated"},
    {"current": "crls/issuing-ca-1/full-03.der", "upload": "crls/issuing-ca-1/full-adcs.der", "outcome": "updated"},
    {"current": "crls/root-ca/full-01.der", "upload": "crls/root-ca/full-02.der", "outcome": "updated"},
    {"current": "crls/root-ca/full-02.der", "upload": "crls/root-ca/full-02-resigned.der", "outcome": "conflict"}
  ]
}
EOF
} >"$STAGE/manifest.json"

if grep -rlq 'PRIVATE KEY' "$STAGE"; then die "private key material in the output"; fi

chmod 755 "$STAGE"
old=''
if [[ -e $OUT ]]; then
  old=$OUT.old.$$
  mv "$OUT" "$old"
fi
mv "$STAGE" "$OUT"
if [[ -n $old ]]; then rm -rf "$old"; fi
echo "generated $(find "$OUT" -type f | wc -l | tr -d ' ') files in $OUT"
