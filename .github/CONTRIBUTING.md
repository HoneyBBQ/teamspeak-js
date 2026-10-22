# Contributing to teamspeak-js

Thanks for helping. Bug reports, fixes, protocol findings and documentation
changes are all welcome. For a larger change, such as a new entry point or an API
change, open an issue first so we can agree on the shape before you write it.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). To report
a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## No proprietary code

Never contribute code, headers, constant tables or decompiled or disassembled
output taken from TeamSpeak's proprietary SDK or applications, and do not paste
them into issues or comments either. That rule cannot bend.

Protocol knowledge comes from watching traffic between a client and a server,
from public documentation, and from open-source implementations under
permissive licences (MIT, Apache-2.0, BSD), which you may consult for protocol
behaviour. Write your own code rather than copying, and respect the licence
terms of whatever you learned from. Do not consult or copy from implementations
under a copyleft licence (GPL, AGPL, LGPL, OSL) or with no licence. Credit your
sources where you use them in the code. If you are not sure where something you
know came from, leave it out and say so in the pull request.

## Setup

You need Node.js 22.12 or newer and pnpm. The exact pnpm version is pinned in
`packageManager` in `package.json`; with [Corepack](https://nodejs.org/api/corepack.html)
(`corepack enable`) the right one is used automatically.

The Node.js and TypeScript versions the package supports, and how that changes
over time, are in the [supported environments](../docs/compatibility.md#supported-environments)
policy; CI enforces them.

```sh
git clone https://github.com/HoneyBBQ/teamspeak-js
cd teamspeak-js
pnpm install
```

## Layout

The code is one package, `@honeybbq/teamspeak`, at the repository root, with
one directory per entry point:

- `src/core` is what every connection shares: the command language, ids,
  errors and the typed commands. It imports nothing from the other two.
- `src/client` is the voice client (`@honeybbq/teamspeak/client`).
- `src/query` is the ServerQuery client (`@honeybbq/teamspeak/query`). It is
  exported, but marked `@experimental`: its API may change in a minor release.
- `src/stream` is TeamSpeak 6 streams (`@honeybbq/teamspeak/stream`), the signalling
  of a screen share. It takes a client through the `StreamsClient` interface and
  imports neither `client` nor `query`; it is marked `@beta`.

`src/client` and `src/query` use the core's public API through its package name,
`@honeybbq/teamspeak`, and take plumbing only from `../core/internal.js`. They
never import each other. An entry exports only its own symbols, so the client
entry does not re-export the core.

## Checks

CI runs these, so run them before you push:

```sh
pnpm check        # typecheck, lint, and format check
pnpm test         # unit tests
pnpm build        # build the package
pnpm check:docs   # every exported symbol has a doc comment
pnpm api:check    # the public API matches the committed report
```

`pnpm fmt` rewrites files to the project's formatting if `pnpm check` complains
about it.

### Public API report

The public API of each entry point is recorded in `api/core.api.md`,
`api/client.api.md`, `api/query.api.md` and `api/stream.api.md`, and reviewed like code. `pnpm api:check` fails with a diff when the built
declarations and the record disagree, so an API change cannot land without
showing up in the same commit. When the change is on purpose, rewrite the
record and commit it with the change:

```sh
pnpm api:report
```

Read the diff before you commit it. A symbol you did not mean to export shows
up there.

## Changesets

Every change a user would notice gets a changeset, which becomes an entry in the
changelog and in the GitHub release notes:

```sh
pnpm changeset
```

A changeset names `@honeybbq/teamspeak` and the bump. Describe the change for
someone upgrading: what changed, and what they have to do about it. The
repository is in prerelease mode (`1.0.0-beta.N`) until 1.0.0, so a changeset is
still the right way to record a breaking change.
[.changeset/README.md](../.changeset/README.md) has the details. Changes nobody
would notice, such as tests, CI and internal refactors, do not need one.

The changelog links each entry to its pull request and commit, and thanks the
author of a first contribution, so a changeset has no `pr:`, `commit:` or `author:` lines. A maintainer
may write or edit a changeset for you, so a first pull request does not need to
learn changesets.

You do not run `pnpm version-packages`; maintainers do, after pushing, with `gh`
logged in or `GITHUB_TOKEN` set.

## Integration tests

The integration suite runs against a real TeamSpeak server and is not part of
`pnpm test`. CI runs it against TeamSpeak 3 and 6.

Start a server in Docker and provision it with the fixture script, which creates
the channels the tests use, grants the permissions they exercise, relaxes
anti-flood, and writes an env file outside the working tree
(`$TS3_FIXTURE_ENV`, by default `ts3-fixture.env` under `$TMPDIR` or `/tmp`) and
prints its path:

```sh
docker run -d --name ts3 -e TS3SERVER_LICENSE=accept \
  -p 9987:9987/udp -p 10011:10011 -p 30033:30033 teamspeak:latest
TS3_QUERY_HOST=127.0.0.1 ./scripts/ts3-fixture.sh
set -a; . "${TS3_FIXTURE_ENV:-${TMPDIR:-/tmp}/ts3-fixture.env}"; set +a
pnpm test:integration
```

The fixture needs `python3`. Without its environment variables the live tests
skip. TeamSpeak 3 serves SSH and WebQuery too, once the container is started with
`-e TS3SERVER_QUERY_PROTOCOLS=raw,ssh,http -e TS3SERVER_SERVERADMIN_PASSWORD=...`
and `-p 10022:10022 -p 10080:10080`: give the fixture `TS3_QUERY_HTTP=127.0.0.1:10080`,
`TS3_QUERY_SSH_PORT=10022`, `TS3_ADMIN_PW` and `TS3_QUERY_SSH_PASSWORD` (the password
you set) as well as `TS3_QUERY_HOST`, and the suite runs over all three. For a TeamSpeak 6 server (`teamspeaksystems/teamspeak6-server`), which has
no raw ServerQuery port, see `.github/workflows/ci.yml` for the environment it
needs, and set `TS3_QUERY_HTTP` instead of `TS3_QUERY_HOST` when running the
fixture. `pnpm test:integration:ts3`, `:ts6` and `:both` run the suite against
servers on ports 9987 and 9988 with the fixture's default channel names.

`pnpm test:integration:instance` runs the tests that stop and delete virtual
servers, edit the instance, reset every permission and stop the server process.
Run it against a server you will throw away, after the rest: it ends with the
process stopped, so the container has to be started again. CI runs it as the last
step of each integration job.

Run one server at a time. A server's flood protection bans an IP that connects
too fast, and two suites at once, or a rerun straight after a failure, can get
yours banned. If that happens, restart the container.

## Changes

- Add a test with a fix or a feature. A bug fix should have a test that fails
  without it.
- If behaviour changes, update the README, the docs and the doc comments.
- Keep commits focused. Messages follow [Conventional Commits](https://www.conventionalcommits.org/),
  as the history does: `feat`, `fix`, `docs`, `ci`, `test`, `refactor` or
  `chore`, with an optional scope, and a `!` after the type for a breaking
  change, for example `fix: resend every handshake step until the server replies`.
- Open the pull request against `main`. The template lists what to check.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](../LICENSE).
