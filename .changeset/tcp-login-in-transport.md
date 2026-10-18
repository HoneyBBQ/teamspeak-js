---
"@honeybbq/teamspeak": major
---

The raw TCP login moves from the `QueryClient` options into the `tcp` transport. `QueryClientOptions.login` is gone; give the account as `transport.login`, next to the `host`, the way SSH and WebQuery already carry their credentials. How to connect and authenticate is the transport's, and what to do on the session (`server`, `nickname`, `events`, `reconnect`) stays on the client. The type now says what was only a runtime rule before: `login` exists on the `tcp` arm and on no other, so a login beside an SSH or WebQuery transport no longer type-checks.

```ts
// before
new QueryClient({
  transport: { kind: "tcp", host: "ts.example.com" },
  login: { name: "serveradmin", password },
  server: { id: 1 },
});

// after
new QueryClient({
  transport: { kind: "tcp", host: "ts.example.com", login: { name: "serveradmin", password } },
  server: { id: 1 },
});
```

A caller in plain JavaScript who still passes the top-level `login` gets a `TypeError` that names `transport.login`, rather than a client that connects without logging in. `transport.login` on any kind other than `tcp` throws too. The login is still sent after every reconnect, and `client.login(name, password)` is unchanged.

A `custom` transport no longer takes a `login`: its `open` builds the connection, so it logs in there, or the application calls `client.login()` once connected. To keep the client's own login and reconnects, open the connection with `kind: "tcp"` and its `connect` function instead.
