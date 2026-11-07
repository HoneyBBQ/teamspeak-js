---
"@honeybbq/teamspeak": minor
---

BREAKING: the SDK no longer paces, resends or keeps anything alive on its own; each is yours to choose, through the new `lineMiddleware` option.

`ClientOptions.lineMiddleware` and `QueryClientOptions.lineMiddleware` wrap every command line the client sends, outermost first: the typed commands once encoded, the raw lines of `exec` and `execNoWait`, and the client's own (`setconnectioninfo`, the streams' commands, ServerQuery's `login`, `use`, `version`, `whoami`, `servernotifyregister` and `clientlist`). The voice handshake's own lines and the goodbye (`clientdisconnect`, `quit`) do not pass. A middleware may call `next` again, each call with a return code of its own; `LineOptions.signal` aborts on the caller's signal, the command's timeout and disconnect, and the timeout bounds the whole chain. New exports: `CommandLine`, `LineOptions`, `LineSender`, `LineMiddleware`, and `floodWaitMs(error)`, which reads the wait of a 524 refusal in milliseconds. `CommandOptions.onSent` now fires when the line is handed to the connection after the middleware, once, and on a `QueryClient` too. The new flood control page and `examples/flood-control.ts` have a token bucket, a resend and a cost-weighted bucket to copy.

Removed: the voice client's command throttle and its 524 resend; the ServerQuery 524 resend; `QueryClientOptions.keepAliveMs`; `DEFAULT_EVENT_CATEGORIES`. A `QueryClient` with no `events` now registers for nothing and fetches no roster, and `events` is `{ categories }` with at least one category (no boolean). The voice client no longer sends `clientupdate client_input_muted=0 client_output_muted=0` after `initserver`, no longer takes its client id from a nickname match when `initserver` has no `aclid` (the attempt fails with a `HandshakeError`), and stream join requests no longer have their identity lookups capped at 8 at once.

On TeamSpeak 6, `clientgetvariables` could resolve with no row while other commands were in flight (the server sent its `error` ahead of the row); it now waits for the row for the client asked.
