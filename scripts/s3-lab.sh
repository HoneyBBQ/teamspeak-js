#!/usr/bin/env bash
# Start a TeamSpeak 6 server with S3 file transfer, and the storage it keeps
# the files in, for the live S3 tests.
#
#   ./scripts/s3-lab.sh "$RUNNER_TEMP/s3-lab"
#
# Runs, on a Docker network of their own:
#
#   storage   an S3-compatible object store (RustFS) holding one bucket
#   front     nginx, serving the storage over TLS as s3.localhost and
#             <bucket>.s3.localhost, with a certificate from a CA made here
#   server    a TeamSpeak 6 server with S3 file transfer on, trusting that CA
#
# The server signs URLs for <bucket>.s3.localhost:<storage port> and reaches
# the storage there itself, so the front is published on the same port and the
# tests' host must resolve that name to itself: *.localhost does on macOS and
# with systemd-resolved; elsewhere add it to /etc/hosts. The server is then
# provisioned with ts3-fixture.sh, and what the tests need is appended to
# $TS3_FIXTURE_ENV:
#
#   TEAMSPEAK_S3_ADDR             the server's voice address
#   TEAMSPEAK_S3_SERVER_PASSWORD  the password the fixture put on it
#   TEAMSPEAK_S3_CA               the CA the storage's certificate is from
#   TEAMSPEAK_S3_QUERY_URL        its WebQuery, for the tests that need an
#   TEAMSPEAK_S3_QUERY_API_KEY    admin to set permissions
#
# Measured on TeamSpeak 6 6.0.0-beta13.1, two things decide whether the server
# reaches the storage at all. It trusts certificates from
# /etc/ssl/certs/ca-certificates.crt alone (not SSL_CERT_FILE, not a hashed
# link), so the CA is appended to the image's own bundle. And it addresses
# the bucket as a virtual host, so the storage must know its domain and the
# front must pass the Host header, port included, as the server signed it.
# Either one wrong, and the server logs "Cancel file list request, due to
# connection issue" and lists no files.
#
# The directory given (made if missing) receives the certificates, the
# server's CA bundle and the front's configuration. Everything is throwaway:
# keep it out of the working tree.
set -euo pipefail

dir="${1:?usage: s3-lab.sh <directory>}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"

prefix="${S3_LAB_PREFIX:-ts-s3}"
ts6_image="${TS6_IMAGE:-$("$here/ci-image.sh" ts6)}"
storage_image="${S3_STORAGE_IMAGE:-$("$here/ci-image.sh" rustfs)}"
nginx_image="${NGINX_IMAGE:-$("$here/ci-image.sh" nginx)}"
voice_port="${S3_LAB_VOICE_PORT:-9989}"
query_port="${S3_LAB_QUERY_PORT:-10082}"
transfer_port="${S3_LAB_TRANSFER_PORT:-30035}"
storage_port="${S3_LAB_STORAGE_PORT:-8443}"
domain=s3.localhost
bucket=teamspeak
region=us-east-1
access_key=s3-lab-access
secret_key="s3-lab-secret-$(openssl rand -hex 12)"
network="$prefix"

# Certificates: a CA, and a server certificate it signed for the storage's
# domain and every bucket under it.
(
  cd "$dir"
  rm -f ca.pem ca.key server.pem server.key server.csr ca.srl extensions.cnf
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key 2>/dev/null
  openssl req -x509 -new -key ca.key -sha256 -days 2 \
    -subj "/CN=teamspeak S3 live test CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out ca.pem
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key 2>/dev/null
  openssl req -new -key server.key -subj "/CN=$domain" -out server.csr
  cat > extensions.cnf <<EXT
subjectAltName=DNS:$domain,DNS:*.$domain
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
EXT
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
    -days 2 -sha256 -extfile extensions.cnf -out server.pem 2>/dev/null
  rm -f ca.key ca.srl server.csr extensions.cnf
  chmod 644 ca.pem server.pem server.key
  openssl verify -CAfile ca.pem server.pem >/dev/null
)

docker rm -f "$prefix-server" "$prefix-front" "$prefix-storage" >/dev/null 2>&1 || true
docker network rm "$network" >/dev/null 2>&1 || true
docker network create "$network" >/dev/null

docker run -d --name "$prefix-storage" --network "$network" \
  -e RUSTFS_ACCESS_KEY="$access_key" -e RUSTFS_SECRET_KEY="$secret_key" \
  -e RUSTFS_ADDRESS=:9000 -e RUSTFS_VOLUMES=/data -e RUSTFS_SERVER_DOMAINS="$domain" \
  "$storage_image" >/dev/null

cat > "$dir/nginx.conf" <<NGINX
events {}
http {
  resolver 127.0.0.11 valid=10s;
  server {
    listen $storage_port ssl;
    server_name $domain *.$domain;
    ssl_certificate /tls/server.pem;
    ssl_certificate_key /tls/server.key;
    client_max_body_size 0;
    location / {
      set \$storage http://$prefix-storage:9000;
      proxy_pass \$storage;
      # The server signs the Host it sends, port included.
      proxy_set_header Host \$http_host;
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
    }
  }
}
NGINX
docker run -d --name "$prefix-front" --network "$network" \
  --network-alias "$domain" --network-alias "$bucket.$domain" \
  -p "$storage_port:$storage_port" \
  -v "$dir/server.pem:/tls/server.pem:ro" -v "$dir/server.key:/tls/server.key:ro" \
  -v "$dir/nginx.conf:/etc/nginx/nginx.conf:ro" \
  "$nginx_image" >/dev/null

# The bucket, made through the front as the server will reach it.
for i in $(seq 1 30); do
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --cacert "$dir/ca.pem" \
    --resolve "$bucket.$domain:$storage_port:127.0.0.1" \
    --aws-sigv4 "aws:amz:$region:s3" --user "$access_key:$secret_key" \
    -X PUT "https://$bucket.$domain:$storage_port/" 2>/dev/null || true)
  [ "$status" = 200 ] && break
  sleep 1
done
if [ "$status" != 200 ]; then
  docker logs "$prefix-front" >&2 || true
  docker logs "$prefix-storage" >&2 || true
  echo "the storage did not make the bucket (HTTP $status)" >&2
  exit 1
fi

docker run --rm --entrypoint cat "$ts6_image" /etc/ssl/certs/ca-certificates.crt >"$dir/ca-bundle.crt"
cat "$dir/ca.pem" >>"$dir/ca-bundle.crt"

docker run -d --name "$prefix-server" --network "$network" \
  -p "$voice_port:9987/udp" -p "$query_port:10080" -p "$transfer_port:$transfer_port" \
  -v "$dir/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro" \
  -e TSSERVER_LICENSE_ACCEPTED=accept \
  -e TSSERVER_QUERY_HTTP_ENABLED=1 \
  -e TSSERVER_FILE_TRANSFER_PORT="$transfer_port" \
  -e TSSERVER_S3FT_ENABLED=1 \
  -e TSSERVER_S3FT_DOMAIN="$domain:$storage_port" \
  -e TSSERVER_S3FT_BUCKET="$bucket" \
  -e TSSERVER_S3FT_REGION="$region" \
  -e TSSERVER_S3FT_ACCESS_KEY="$access_key" \
  -e TSSERVER_S3FT_SECRET_KEY="$secret_key" \
  "$ts6_image" >/dev/null

for i in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$query_port/1/version" || true)" != 000 ]; then
    break
  fi
  sleep 1
done
# The server reads every channel's file list from the storage as it starts:
# the line that says it could not is the one failure that matters here.
sleep 3
if docker logs "$prefix-server" 2>&1 | grep -q "due to connection issue\|S3 HTTP request failed"; then
  docker logs "$prefix-server" >&2
  echo "the server could not reach the storage" >&2
  exit 1
fi

fixture_env="$dir/fixture.env"
TS3_FIXTURE_ENV="$fixture_env" \
TS3_CONTAINER="$prefix-server" \
TS3_QUERY_HOST="" \
TS3_QUERY_HTTP="127.0.0.1:$query_port" \
TS3_QUERY_PORT="$query_port" \
TS3_VOICE_PORT="$voice_port" \
  "$here/ts3-fixture.sh" >/dev/null

read_env() { sed -n "s/^export $1=//p" "$fixture_env"; }

# Every client may make directories, as it may upload: on an S3 file area an
# upload into a directory the server does not list yet needs that power too.
webquery() {
  curl -sS --max-time 10 -H "x-api-key: $(read_env TEAMSPEAK_QUERY_API_KEY)" \
    "http://127.0.0.1:$query_port/1/$1"
}
default_group=$(webquery serverinfo | python3 -c \
  'import json, sys; print(json.load(sys.stdin)["body"][0]["virtualserver_default_server_group"])')
webquery "servergroupaddperm?sgid=$default_group&permsid=i_ft_directory_create_power&permvalue=100&permnegated=0&permskip=0" \
  | grep -q '"code":0' || { echo "could not grant i_ft_directory_create_power" >&2; exit 1; }
addr=$(read_env TEAMSPEAK_ADDR)
password=$(read_env TEAMSPEAK_SERVER_PASSWORD)
query_url=$(read_env TEAMSPEAK_QUERY_URL)
api_key=$(read_env TEAMSPEAK_QUERY_API_KEY)
[ -n "$addr" ] || { echo "the fixture wrote no address" >&2; exit 1; }
[ -n "$api_key" ] || { echo "the fixture wrote no api key" >&2; exit 1; }

out="${TS3_FIXTURE_ENV:-${TMPDIR:-/tmp}/ts3-fixture.env}"
{
  echo "export TEAMSPEAK_S3_ADDR=$addr"
  echo "export TEAMSPEAK_S3_SERVER_PASSWORD=$password"
  echo "export TEAMSPEAK_S3_CA=$dir/ca.pem"
  echo "export TEAMSPEAK_S3_QUERY_URL=$query_url"
  echo "export TEAMSPEAK_S3_QUERY_API_KEY=$api_key"
} >>"$out"
echo "$out"
