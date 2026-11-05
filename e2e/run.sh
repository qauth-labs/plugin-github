#!/usr/bin/env bash
# The end-to-end suite: QAuth's released server image with this plugin
# installed the way an operator installs it, against a mock GitHub Enterprise
# Server, driven over HTTP by e2e/github.e2e.test.ts.
#
# Needs docker (with compose), openssl and node. Run it from anywhere:
#
#   bash e2e/run.sh
#
# It packs the plugin as npm would publish it, makes throwaway secrets and a
# throwaway CA in e2e/.work/, builds the image (e2e/Dockerfile), starts the
# deployment (e2e/compose.yml), runs the suite and takes everything down.
# On a failure it prints the server's and the mock's logs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
work="$here/.work"
compose=(docker compose --file "$here/compose.yml")

rm -rf "$work"
mkdir -p "$work/certs" "$work/ca" "$work/keys" "$work/pack"

# A CA for this run only, and the mock's certificate for every name it is
# reached by: the two network names, and localhost for the suite on the host.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=plugin-github e2e CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  -keyout "$work/ca/ca.key" -out "$work/certs/ca.crt" 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=mock-github' \
  -keyout "$work/certs/mock.key" -out "$work/ca/mock.csr" 2> /dev/null
printf '%s\n' 'subjectAltName=DNS:mock-github,DNS:mock-github-unlisted,DNS:localhost' \
  'extendedKeyUsage=serverAuth' > "$work/ca/mock.ext"
openssl x509 -req -in "$work/ca/mock.csr" -CA "$work/certs/ca.crt" -CAkey "$work/ca/ca.key" \
  -CAcreateserial -days 1 -extfile "$work/ca/mock.ext" -out "$work/certs/mock.crt" 2> /dev/null
# The mock reads its key through a read-only bind mount.
chmod 644 "$work/certs/mock.key"

# The server's signing key and secrets, fresh for this run.
openssl genpkey -algorithm ed25519 -out "$work/keys/jwt-private.pem" 2> /dev/null
openssl pkey -in "$work/keys/jwt-private.pem" -pubout -out "$work/keys/jwt-public.pem"
JWT_PRIVATE_KEY="$(cat "$work/keys/jwt-private.pem")"
JWT_PUBLIC_KEY="$(cat "$work/keys/jwt-public.pem")"
KEK="$(openssl rand -base64 32)"
SESSION_COOKIE_SECRET="$(openssl rand -base64 48)"
MOCK_GITHUB_CLIENT_ID="Iv23e2eClient$(openssl rand -hex 4)"
MOCK_GITHUB_CLIENT_SECRET="$(openssl rand -hex 20)"
export JWT_PRIVATE_KEY JWT_PUBLIC_KEY KEK SESSION_COOKIE_SECRET
export MOCK_GITHUB_CLIENT_ID MOCK_GITHUB_CLIENT_SECRET

# The allowlist is read through a bind mount; others must not be able to write it.
chmod 644 "$here/egress-allowlist.json"

# The plugin as npm would receive it.
(cd "$root" && npm pack --silent --pack-destination "$work/pack" > /dev/null)
cp "$work"/pack/*.tgz "$work/plugin.tgz"

finish() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- the end-to-end suite failed; the deployment's logs follow ---" >&2
    "${compose[@]}" --profile plugin-api-off logs --no-color auth-server auth-server-plugin-api-off \
      mock-github migrate >&2 || true
  fi
  "${compose[@]}" --profile plugin-api-off down --volumes --remove-orphans > /dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT

wait_ready() {
  local url="$1"
  for _ in $(seq 1 120); do
    if curl --silent --fail "$url" 2> /dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 1
  done
  echo "$url did not become ready" >&2
  return 1
}

"${compose[@]}" build auth-server
"${compose[@]}" up --detach auth-server
wait_ready http://localhost:3000/ready
# The second server boots on the database the first one seeded.
"${compose[@]}" --profile plugin-api-off up --detach --no-build auth-server-plugin-api-off
wait_ready http://localhost:3010/ready

cd "$root"
E2E_COMPOSE_FILE="$here/compose.yml" \
E2E_WORK="$work" \
NODE_EXTRA_CA_CERTS="$work/certs/ca.crt" \
  npx vitest run --config e2e/vitest.config.ts
