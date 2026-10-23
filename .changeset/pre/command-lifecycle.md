---
"@honeybbq/teamspeak": patch
---

`disconnect()` now reaches the server when commands are queued. The goodbye (`clientdisconnect`) used to wait behind the flood throttle's queue and, with about four commands waiting, missed its one second, so the server kept a ghost session and an immediate reconnect with the same identity was refused with error 521 (too many clones). The goodbye now skips the throttle, and a client that is still connecting says goodbye as soon as its `clientinit` is out. Commands still waiting for their turn when `disconnect()` starts reject with a `NotConnectedError` and are never sent.

A command the server refuses as flooding (error 524, `ErrorCode.ClientIsFlooding`) with `extra_msg=retry in 1985ms` is now sent again after that wait, up to three times and while its timeout allows, and every other command waits with it; sooner, each refused command added to the debt. The server does not run a refused command, so the resend is safe. A refusal that cannot be retried rejects as before.

A reconnect backoff that cannot work is now a `RangeError` from the `Client` and `QueryClient` constructors instead of a tight retry loop: `initialDelayMs` and `maxDelayMs` must be above 0 and `maxDelayMs` not below `initialDelayMs` (an unset `maxDelayMs` follows a larger `initialDelayMs`), `factor` at least 1, `jitter` at most 1, `maxAttempts` a whole number of 0 or more, and none may be `NaN` or infinite.

`getChannelDescription()` rejects with a `NoDataError` when the server sends no answer, where it returned an empty string that read as a channel with no description.

Error ids, return codes and failed permission ids are read strictly as unsigned 32-bit decimals. `12abc` was error 12 and a 20-digit id some code no one defined; both are now `ErrorCode.Undefined`, and a return code that is not a number names no command.
