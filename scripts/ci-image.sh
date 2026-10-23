#!/usr/bin/env bash
# Print the container image reference CI uses for one of ts3, ts6 or nginx.
# The reference lives in ci/images/Dockerfile.<name>, where Dependabot can
# update it; this is the one place the workflow reads it from.
set -euo pipefail
name=${1:?usage: ci-image.sh ts3|ts6|nginx}
file="$(dirname "$0")/../ci/images/Dockerfile.$name"
ref=$(sed -n 's/^FROM //p' "$file")
[ -n "$ref" ] || { echo "no FROM line in $file" >&2; exit 1; }
echo "$ref"
