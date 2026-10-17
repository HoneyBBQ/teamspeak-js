#!/usr/bin/env bash
# Provision the local TeamSpeak test server so the integration suite exercises
# real behaviour instead of skipping on permissions.
#
#   docker run -d --name ts3 -e TS3SERVER_LICENSE=accept \
#     -p 9987:9987/udp -p 10011:10011 -p 30033:30033 teamspeak:latest
#   ./scripts/ts3-fixture.sh
#   source "${TS3_FIXTURE_ENV:-${TMPDIR:-/tmp}/ts3-fixture.env}"
#   pnpm test:integration
#
# Creates the channels the tests need (one password-protected), puts a password
# on the server itself, grants the default server group the permissions they
# exercise, relaxes anti-flood so a handful of rapid connections from one IP are
# not banned, and writes an env file with the matching environment variables.
# The file goes to $TS3_FIXTURE_ENV, by default ts3-fixture.env under $TMPDIR (or /tmp), never
# into the working tree; the last line printed is the path to source.
#
# Every command is checked. The fixture used to print "fixture ready" even when
# it could not reach the server at all, because each command ended in `|| true`;
# the suite then ran against an unprovisioned server and skipped its way to
# green, which is how a protocol bug stayed invisible for months.
#
# TS3_QUERY_GUEST=1 marks a TeamSpeak 6 server (beta13 or later) that accepts
# guest ServerQuery logins, so the suite also tests those.
#
# Both server generations serve raw ServerQuery, SSH and WebQuery (TS3 from
# 3.12, TS6 from its first release), but TS3 has them off except raw: start it
# with TS3SERVER_QUERY_PROTOCOLS=raw,ssh,http and TS3SERVER_SERVERADMIN_PASSWORD
# set. Give this script TS3_QUERY_HOST and TS3_QUERY_HTTP together and it
# provisions over raw TCP, creates the WebQuery api key there (a TS3 server
# prints none in its log), and writes the environment for both transports.
#
# Needs python3, to read WebQuery's JSON replies.
set -euo pipefail

CONTAINER="${TS3_CONTAINER:-ts3}"
QUERY_HOST="${TS3_QUERY_HOST:-}"
QUERY_HTTP="${TS3_QUERY_HTTP:-}"
QUERY_PORT="${TS3_QUERY_PORT:-10011}"
# Written only once provisioning has succeeded. A stale file from an earlier
# run would let the suite believe it is provisioned when this run failed, which
# is the same silent-skip problem in a different place.
ENV_FILE="${TS3_FIXTURE_ENV:-${TMPDIR:-/tmp}/ts3-fixture.env}"
rm -f "$ENV_FILE"

PASSWORD_CHANNEL="${TS3_PASSWORD_CHANNEL:-Secret}"
PASSWORD_CHANNEL_PASSWORD="${TS3_PASSWORD_CHANNEL_PASSWORD:-hunter2}"
DEFAULT_CHANNEL="${TS3_DEFAULT_CHANNEL:-Alpha}"
# The server's own password. Every voice client then connects with it, so each
# connect exercises the password handshake, and a client that sends none or the
# wrong one is the rejection the suite checks for. ServerQuery logins do not
# use it. No spaces or other characters a query command would have to escape.
SERVER_PASSWORD="${TS3_SERVER_PASSWORD:-fixture-server-password}"

# Which container holds the credentials.
#
# In CI the server is a service container, whose name GitHub generates rather
# than "ts3", so the name is only a hint: fall back to finding it by image. A
# host can run several TeamSpeak containers at once — a TS3 and a TS6 side by
# side — and they print different credentials, so the first candidate is not
# necessarily the right one. Each candidate is therefore *probed* below and the
# one that answers wins, rather than whichever happens to be named first.
containers=()
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  containers+=("$CONTAINER")
fi
for id in $(docker ps --format '{{.ID}} {{.Image}}' | grep 'teamspeak' | cut -d' ' -f1 || true); do
  containers+=("$id")
done

credential_from_logs() {
  docker logs "$2" 2>&1 | grep -o "$1= \"[^\"]*\"" | head -1 | cut -d'"' -f2 || true
}

# The api key whose server actually accepts it.
webquery_key_works() {
  [ -n "$1" ] || return 1
  [ "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -H "x-api-key: $1" "http://${QUERY_HTTP}/1/serverinfo" 2>/dev/null || true)" = "200" ]
}

# The password whose server actually accepts it.
tcp_password_works() {
  [ -n "$1" ] || return 1
  local reply
  reply="$(printf 'login serveradmin %s\r\nquit\r\n' "$1" | nc -w 4 "$QUERY_HOST" "$QUERY_PORT" 2>/dev/null || true)"
  printf '%s' "$reply" | grep -q 'error id=0'
}

ADMIN_PW="${TS3_ADMIN_PW:-}"
HTTP_API_KEY="${TS3_API_KEY:-}"

# Provision over WebQuery only where there is no raw port to do it over. A server
# with both gets its api key created over the raw one.
USE_HTTP=""
if [ -n "$QUERY_HTTP" ] && [ -z "$QUERY_HOST" ]; then
  USE_HTTP=1
fi

if [ -n "$USE_HTTP" ]; then
  for candidate in "${containers[@]}"; do
    [ -n "$HTTP_API_KEY" ] && break
    key="$(credential_from_logs apikey "$candidate")"
    if webquery_key_works "$key"; then
      HTTP_API_KEY="$key"
      CONTAINER="$candidate"
    fi
  done

  # Without the key the commands below cannot work. Say so here, where the
  # reason is obvious, rather than letting the tests fail later for a reason
  # that is not theirs.
  if [ -z "$HTTP_API_KEY" ]; then
    echo "no WebQuery api key found that http://${QUERY_HTTP} accepts" >&2
    echo "set TS3_API_KEY, or check TS3_QUERY_HTTP points at a running server" >&2
    exit 1
  fi
elif [ -z "$ADMIN_PW" ]; then
  for candidate in "${containers[@]}"; do
    [ -n "$ADMIN_PW" ] && break
    pw="$(credential_from_logs password "$candidate")"
    if tcp_password_works "$pw"; then
      ADMIN_PW="$pw"
      CONTAINER="$candidate"
    fi
  done

  if [ -z "$ADMIN_PW" ]; then
    echo "no serveradmin password accepted by $QUERY_HOST:$QUERY_PORT" >&2
    echo "set TS3_ADMIN_PW, or set TS3_QUERY_HTTP to use WebQuery instead" >&2
    exit 1
  fi
fi

# Read WebQuery's JSON as the raw ServerQuery text the rest of this script
# greps for: one line per row of "key=value key=value", and an "error id=N" line
# when the server refuses. Normalising here means the two transports are
# indistinguishable from the caller's side, so the fixture stays one script.
#
# WebQuery always answers JSON and always answers HTTP 200 for a refused
# command, so neither the content type nor the status line says whether the
# command worked — only the status code inside the body does.
read_webquery_response() {
  python3 -c '
import json, sys

raw = sys.stdin.read()
try:
    doc = json.loads(raw)
except ValueError:
    sys.stdout.write("error id=0 msg=unreadable_webquery_response\n")
    sys.exit(0)

status = doc.get("status") or {}
for row in (doc.get("body") or []):
    if isinstance(row, dict):
        sys.stdout.write(" ".join("%s=%s" % (k, v) for k, v in row.items()) + "\n")

code = status.get("code", 0)
if code:
    sys.stdout.write("error id=%s msg=%s\n" % (code, status.get("message", "")))
'
}

http_request() {
  local path="$1" response code body
  if response="$(curl -sS --max-time 10 -w '\n%{http_code}' \
      -H "x-api-key: $HTTP_API_KEY" "http://${QUERY_HTTP}${path}")"; then
    code="${response##*$'\n'}"
    body="${response%$'\n'*}"
  else
    printf 'error id=0 msg=webquery_unreachable\n'
    return 0
  fi

  if [ "$code" != "200" ]; then
    printf 'error id=%s msg=http_%s\n' "$code" "$code"
    return 0
  fi

  printf '%s' "$body" | read_webquery_response
}

# Translate one raw ServerQuery line into a WebQuery request. The commands are
# identical, only the framing differs: "serveredit a=1 b=2" becomes
# GET /1/serveredit?a=1&b=2.
query_http_line() {
  local line="$1" name rest query
  name="${line%% *}"
  if [ "$name" = "$line" ]; then
    http_request "/1/${name}"
    return
  fi

  rest="${line#* }"
  # Parameters are space-separated key=value pairs; URL-encode the separators.
  query="$(printf '%s' "$rest" | sed 's/ /\&/g')"
  http_request "/1/${name}?${query}"
}

query_tcp() {
  if [ -n "$QUERY_HOST" ]; then
    nc -w 4 "$QUERY_HOST" "$QUERY_PORT"
    return
  fi

  docker exec -i "$CONTAINER" nc -w 4 127.0.0.1 "$QUERY_PORT"
}

# Send ServerQuery commands.
#
# Three transports, because the two server generations disagree about this:
#
#   TS3  raw ServerQuery on TCP 10011 (nc inside the container, or over the
#        network in CI)
#   TS6  no raw query at all — it serves HTTP instead, so the same commands go
#        over WebQuery, which TS3 also supports
#
# TS3_QUERY_HOST selects direct TCP; TS3_QUERY_HTTP alone selects WebQuery;
# failing both, the query client runs inside the container.
query() {
  if [ -n "$USE_HTTP" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      # login and use address the raw query session, which WebQuery replaces
      # with the API key; sending them would just be two unknown commands.
      case "$line" in
        login* | use*) continue ;;
      esac
      query_http_line "$line"
    done
    return
  fi

  {
    printf 'login serveradmin %s\r\nuse 1\r\n' "$ADMIN_PW"
    while IFS= read -r line; do printf '%s\r\n' "$line"; done
    printf 'quit\r\n'
    sleep 2
  } | query_tcp
}

# Run commands and fail on the first refusal. Both transports end up emitting
# "error id=N"; an id of 0 is success, and nothing else is acceptable.
#
# Checking this is the point of the exercise: the server answers a refused
# command over a perfectly healthy connection, so neither the transport nor its
# exit status is evidence that anything happened.
#
# The output goes to command_output rather than to stdout because the natural
# shape — output="$(run_commands <<COMMANDS ...)" — runs this in a subshell,
# where the exit below kills only the subshell and the failure then surfaces
# later as some unrelated complaint.
command_output=""
run_commands() {
  local output code attempt
  attempt=1
  while :; do
    output="$(query)" || output="error id=0 msg=query_transport_failed"

    code="$(printf '%s' "$output" | grep -o 'error id=[0-9]*' | grep -o '[0-9]*' | grep -v '^0$' | head -1 || true)"

    # 524 is "client is flooding", which the server clears on its own. Retrying
    # is what makes this script survive being run from an address that is not
    # in query_ip_allowlist — in CI the fixture arrives over a published port,
    # so it is subject to the flood limit and cannot whitelist itself out of it.
    if [ "$code" = "524" ] && [ "$attempt" -lt 6 ]; then
      attempt=$((attempt + 1))
      sleep 3
      continue
    fi

    break
  done

  if [ -n "$code" ]; then
    echo "the server refused the fixture commands:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  command_output="$output"
}

# Relax the ServerQuery flood limit before anything else.
#
# This has to be the first command: the default is 10 commands in 3 seconds and
# provisioning sends more than that, so if it were set after the commands it
# protects, the server would refuse them (error 524) instead.
#
# Note this is a *different* limit from the virtual-server antiflood set further
# down: that one rate-limits the voice clients the tests connect as, this one
# rate-limits this script.
run_commands <<'PROBE'
instanceedit serverinstance_serverquery_flood_commands=1000 serverinstance_serverquery_flood_time=1 serverinstance_serverquery_ban_time=1
PROBE

# A TS3 server prints no WebQuery api key, so one is made over the raw session.
# lifetime=0 never expires and scope=manage allows every command, which is what
# the suite needs; the key is shown once, here, and goes into the env file.
if [ -n "$QUERY_HTTP" ] && [ -z "$HTTP_API_KEY" ]; then
  run_commands <<'PROBE'
apikeyadd scope=manage lifetime=0
PROBE
  HTTP_API_KEY="$(printf '%s' "$command_output" | grep -o 'apikey=[^ ]*' | head -1 | cut -d= -f2 || true)"
  # TS3 opens its HTTP port a few seconds after the raw one.
  key_accepted=""
  for _ in $(seq 1 30); do
    if webquery_key_works "$HTTP_API_KEY"; then
      key_accepted=1
      break
    fi
    sleep 1
  done
  if [ -z "$key_accepted" ]; then
    echo "the api key made over raw ServerQuery is not accepted by http://${QUERY_HTTP}" >&2
    echo "start the server with TS3SERVER_QUERY_PROTOCOLS=raw,ssh,http" >&2
    exit 1
  fi
fi

channel_list() {
  run_commands <<'PROBE'
channellist
PROBE
  printf '%s' "$command_output"
}

# The groups new clients actually join, which is whatever the server reports as
# its default — hard-coding a group id is how the tests end up skipping on
# permissions instead of exercising them.
run_commands <<'PROBE'
serverinfo
PROBE
DEFAULT_GROUP="$(printf '%s' "$command_output" | grep -o 'virtualserver_default_server_group=[0-9]*' | head -1 | cut -d= -f2 || true)"

if [ -z "$DEFAULT_GROUP" ]; then
  echo "the server did not report a default server group" >&2
  exit 1
fi

# Create only what is missing. Re-running used to report "channel name is
# already in use"; creating only what is absent is both quieter and checkable.
existing="$(channel_list)"
create_missing() {
  local name="$1"
  shift
  if printf '%s' "$existing" | grep -q "channel_name=$name"; then
    return
  fi
  run_commands <<COMMANDS
channelcreate channel_name=$name channel_flag_permanent=1 $*
COMMANDS
}

create_missing "$DEFAULT_CHANNEL"
create_missing "$PASSWORD_CHANNEL" "channel_password=$PASSWORD_CHANNEL_PASSWORD"

# The virtual-server antiflood, which is a separate limit from the ServerQuery
# flood relaxed above: this one rate-limits the voice clients the tests connect
# as, that one rate-limits this script.
run_commands <<COMMANDS
serveredit virtualserver_antiflood_points_needed_command_block=65000 virtualserver_antiflood_points_needed_ip_block=65000 virtualserver_antiflood_points_tick_reduce=65000 virtualserver_password=$SERVER_PASSWORD
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_virtualserver_channel_list permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_virtualserver_client_list permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_virtualserver_info_view permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_client_info_view permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_client_remoteaddress_view permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=i_client_whisper_power permvalue=100 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_virtualserver_servergroup_list permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_channel_create_temporary permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_channel_delete_temporary permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_channel_delete_flag_force permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=i_ft_file_upload_power permvalue=100 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=i_ft_file_download_power permvalue=100 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=i_ft_file_browse_power permvalue=100 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=i_ft_file_delete_power permvalue=100 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_client_permissionoverview_own permvalue=1 permnegated=0 permskip=0
servergroupaddperm sgid=$DEFAULT_GROUP permsid=b_client_offline_textmessage_send permvalue=1 permnegated=0 permskip=0
COMMANDS

# Read back what the tests will read. Provisioning that quietly did nothing is
# worse than provisioning that failed loudly.
final="$(channel_list)"
for name in "$DEFAULT_CHANNEL" "$PASSWORD_CHANNEL"; do
  if ! printf '%s' "$final" | grep -q "channel_name=$name"; then
    echo "channel '$name' is missing after provisioning" >&2
    printf '%s\n' "$final" >&2
    exit 1
  fi
done

run_commands <<'PROBE'
serverinfo
PROBE
if ! printf '%s' "$command_output" | grep -q 'virtualserver_flag_password=1'; then
  echo "the server does not report a password after provisioning" >&2
  exit 1
fi

# Which generation this is, read from the server's own version, so that a suite
# can check what its client concluded against something it did not compute.
run_commands <<'PROBE'
version
PROBE
SERVER_MAJOR="$(printf '%s' "$command_output" | sed -n 's/.*version=\([0-9][0-9]*\)\..*/\1/p' | head -1)"
case "$SERVER_MAJOR" in
  3) SERVER_FAMILY=ts3 ;;
  6) SERVER_FAMILY=ts6 ;;
  *)
    echo "the server did not report a version this fixture knows: $command_output" >&2
    exit 1
    ;;
esac

# The voice port is configurable because a second server on the same host needs
# a different one; CI maps the first to 9987 either way.
VOICE_PORT="${TS3_VOICE_PORT:-9987}"

# The ServerQuery client suite. Each transport the invocation has an endpoint
# for is written: raw TCP where TS3_QUERY_HOST was given, WebQuery where
# TS3_QUERY_HTTP was, so the suite reads what is there and runs each.
QUERY_ENV=""
if [ -n "$QUERY_HOST" ]; then
  QUERY_ENV="export TEAMSPEAK_QUERY_KIND=tcp
export TEAMSPEAK_QUERY_HOST=$QUERY_HOST
export TEAMSPEAK_QUERY_PORT=$QUERY_PORT
export TEAMSPEAK_QUERY_LOGIN_NAME=serveradmin
export TEAMSPEAK_QUERY_LOGIN_PASSWORD=$ADMIN_PW"
fi
if [ -n "$QUERY_HTTP" ]; then
  if [ -z "$QUERY_ENV" ]; then
    QUERY_ENV="export TEAMSPEAK_QUERY_KIND=web"
  fi
  QUERY_ENV="$QUERY_ENV
export TEAMSPEAK_QUERY_URL=http://$QUERY_HTTP
export TEAMSPEAK_QUERY_API_KEY=$HTTP_API_KEY"
fi

# SSH is off unless this server was started with it (TS3 needs query_protocols
# to include ssh), so the suite runs that part only where TS3_QUERY_SSH_PORT says so.
# The host falls back to whichever endpoint this invocation used, which is the
# WebQuery one on a server with no raw TCP port.
if [ -n "${TS3_QUERY_SSH_PORT:-}" ]; then
  SSH_DEFAULT_HOST="${QUERY_HOST:-${QUERY_HTTP%%:*}}"
  QUERY_ENV="$QUERY_ENV
export TEAMSPEAK_QUERY_SSH_HOST=${TS3_QUERY_SSH_HOST:-$SSH_DEFAULT_HOST}
export TEAMSPEAK_QUERY_SSH_PORT=$TS3_QUERY_SSH_PORT
export TEAMSPEAK_QUERY_SSH_USER=${TS3_QUERY_SSH_USER:-serveradmin}
export TEAMSPEAK_QUERY_SSH_PASSWORD=${TS3_QUERY_SSH_PASSWORD:-${ADMIN_PW:-$HTTP_API_KEY}}"
fi

# TeamSpeak 6 beta13 and later accept a guest ServerQuery login without prior
# setup; TS3 does not. The guest tests run only where TS3_QUERY_GUEST=1 says the
# server offers one, and need the SSH or WebQuery endpoint provisioned above.
if [ "${TS3_QUERY_GUEST:-}" = "1" ]; then
  QUERY_ENV="$QUERY_ENV
export TEAMSPEAK_QUERY_GUEST=1"
fi

cat > "$ENV_FILE" <<ENVFILE
# Integration suite environment from scripts/ts3-fixture.sh. Source it before running the suite.
export TEAMSPEAK_ADDR=127.0.0.1:$VOICE_PORT
export TEAMSPEAK_SERVER_PASSWORD=$SERVER_PASSWORD
export TEAMSPEAK_SERVER_HAS_PASSWORD=1
export TEAMSPEAK_DEFAULT_CHANNEL=$DEFAULT_CHANNEL
export TEAMSPEAK_PASSWORD_CHANNEL=$PASSWORD_CHANNEL
export TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD=$PASSWORD_CHANNEL_PASSWORD
export TEAMSPEAK_QUERY_FAMILY=$SERVER_FAMILY
$QUERY_ENV
ENVFILE

echo "fixture ready — $DEFAULT_CHANNEL + $PASSWORD_CHANNEL present, antiflood relaxed"
echo "source $ENV_FILE"
