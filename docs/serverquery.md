# ServerQuery

The `@experimental` subpath `@honeybbq/teamspeak/query` administers a server
the way the voice protocol cannot: the same typed commands the core exports,
plus the ones only an administrator may run, over the three transports a
ServerQuery speaks.

| Transport | Where                       | Server           | Login             | Notifications |
| --------- | --------------------------- | ---------------- | ----------------- | ------------- |
| `tcp`     | 10011                       | TeamSpeak 3 only | `transport.login` | yes           |
| `ssh`     | 10022                       | both             | the SSH login     | yes           |
| `web`     | 10080 (HTTP), 10443 (HTTPS) | both             | the api key       | **no**        |

TeamSpeak 3 (3.12 and later for WebQuery, 3.3 and later for SSH) serves SSH and
WebQuery as well as raw TCP, but only the raw port is on until
`query_protocols` lists the others; the official Docker image takes it as
`TS3SERVER_QUERY_PROTOCOLS=raw,ssh,http`. TeamSpeak 6 has no raw port. Its
WebQuery also answers a request with no api key as a guest; TeamSpeak 3 refuses
one.

WebQuery is reached over `http:` or `https:`, by the scheme of `url`. TeamSpeak 3
serves HTTPS on 10443 once `query_protocols` lists `https` and
`query_https_certificate_file` and `query_https_private_key_file` are set. The
built-in `fetch` verifies the certificate against the trust store Node uses and
never skips that. A certificate from a private CA, or a self-signed one, is
trusted by starting Node with `NODE_EXTRA_CA_CERTS=ca.pem`, or by a `fetch`
that trusts the CA:

```typescript
import { readFileSync } from "node:fs";
import { Agent, request } from "node:https";

const agent = new Agent({ ca: readFileSync("ca.pem") });
const trusting = ((url: string, init: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      { method: init.method, headers: init.headers as never, agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body as string);
  })) as typeof fetch;

new QueryClient({
  transport: {
    kind: "web",
    url: "https://ts.example.com:10443",
    apiKey,
    fetch: trusting,
  },
});
```

Only raw TCP and SSH carry notifications: the server pushes them down the same
connection. WebQuery has no session to push to and refuses to register, so the
client never tries, and a listener for a server event there throws rather than
sitting silent. `connected` and `disconnected` work on every transport, since
they come from the client itself.

```typescript
import { QueryClient } from "@honeybbq/teamspeak/query";
import { listChannels } from "@honeybbq/teamspeak";

const client = new QueryClient({
  transport: {
    kind: "tcp", // 10011
    host: "ts.example.com",
    login: { name: "serveradmin", password: process.env.QUERY_PASSWORD! },
  },
  server: { id: 1 },
  nickname: "bot",
  events: { categories: ["textserver", "textprivate"] },
  reconnect: { backoff: { initialDelayMs: 1_000 } },
});

client.on("textMessage", (message) => console.log(message.invokerName, message.message));

await client.connect();

for (const channel of await listChannels(client)) console.log(channel.name);

await client.disconnect();
```

The three transports are figures of speech the client rebuilds on every
connection, which is what makes reconnecting possible; `custom` opens one
itself, for a proxy, a tunnel or a test. Each built-in transport also offers
the seam into its own connection — `connect` for `tcp`, returning a `Duplex`,
and `connection` for `ssh`, taking a client or a factory for one — so an
application behind a TLS terminator or a SOCKS proxy, or one that already
holds an SSH client, can supply it. `ssh2` is an optional peer dependency:
without it the other two transports still work, and an `ssh` transport throws
a `MissingDependencyError` naming the package.

A query client delivers the events its categories carry: `serverEdited` comes
under `server`; the channel events, `clientEnter`, `clientLeave` and
`clientMoved` under `channel`; and `textMessage` under the three text
categories. `QueryEventsOption` has the table. The voice client's events about
clients' updates, group changes, subscriptions, plugin commands and typing are
not sent to a ServerQuery connection by TeamSpeak 3 or by TeamSpeak 6 over SSH,
so the query client does not offer them.

`serverFamily` reports which generation the server is, read from its own
`version` answer, and `transport` reads back the live connection for metrics.

## SSH host keys

The `ssh` transport checks the server's host key before it sends the login, and
there is no default for how: the login is a credential, normally
`serveradmin`'s, and a client that accepts any key hands it to whatever answers
the port. Give exactly one of these, or the client refuses to be built, naming
all three:

```typescript
const client = new QueryClient({
  transport: {
    kind: "ssh",
    host: "ts.example.com",
    username: "serveradmin",
    password: process.env.QUERY_PASSWORD!,
    knownHosts: "/etc/ssh/ssh_known_hosts",
  },
});
```

- `knownHosts`: the path of an OpenSSH `known_hosts` file, read each time a
  connection is attempted and never found on its own: `~/.ssh/known_hosts` is
  used only if you name it. The check is `StrictHostKeyChecking=yes`: a host the
  file does not mention is refused, so is one recorded with another key, and so
  is a key a `@revoked` line names. Plain, `[host]:port` and hashed
  (`ssh-keygen -H`) entries are read. The query port is not 22, so record it as
  `ssh-keyscan -p 10022 ts.example.com`, which writes `[ts.example.com]:10022`;
  an entry for port 22 does not vouch for 10022.
- `hostKey`: your own check, `(key) => void`, that throws to refuse. `key` has
  the host, port, `keyType`, the key's bytes and its `fingerprint`, the
  `SHA256:…` that `ssh-keygen -lf` prints. It has to be synchronous and return
  nothing: a returned value, a `false` included, or a promise is refused rather
  than guessed at.
- `insecureIgnoreHostKey: true`: accept any key. It gives up what the host key
  is for, and is for a test or a throwaway server.

A key that is refused fails the connection with an `SshHostKeyError`, whose
`cause` says why, and nothing was sent: the password has not left the process.
Reconnection does not retry it. A connection you supply yourself through
`connection` is checked by whoever made it, so these options are refused there.

**`@experimental`**: this entry point is new, and its API may change in a
minor release — the options, the transport union and the event map are all
still settling. Pin a version and read the changelog if you depend on it.
