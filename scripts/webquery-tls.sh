#!/usr/bin/env bash
# Make the throwaway certificates the live HTTPS WebQuery tests need.
#
#   ./scripts/webquery-tls.sh "$RUNNER_TEMP/webquery-tls"
#
# Writes a new CA and a server certificate it signed for localhost and
# 127.0.0.1 into the directory given (made if missing):
#
#   ca.pem       what the tests are told to trust, and nothing else
#   server.pem   the certificate a server or TLS front presents
#   server.key   its private key, readable by the server's user
#
# The CA's own key is deleted once the certificate is signed. The files live for
# two days and protect nothing; keep them out of the working tree.
set -euo pipefail

dir="${1:?usage: webquery-tls.sh <directory>}"
mkdir -p "$dir"
cd "$dir"
rm -f ca.pem ca.key server.pem server.key server.csr ca.srl extensions.cnf

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days 2 \
  -subj "/CN=teamspeak live test CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.pem

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key 2>/dev/null
openssl req -new -key server.key -subj "/CN=localhost" -out server.csr
cat > extensions.cnf <<'EXT'
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
EXT
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days 2 -sha256 -extfile extensions.cnf -out server.pem 2>/dev/null

rm -f ca.key ca.srl server.csr extensions.cnf
# A container's server runs as its own user, which has to read the key.
chmod 644 ca.pem server.pem server.key
openssl verify -CAfile ca.pem server.pem >/dev/null
echo "$dir"
