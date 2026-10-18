---
"@honeybbq/teamspeak": minor
---

Commands that take a list now take one: `kickClients`, `moveClients` and `banClients` (which returns every ban id the server reports) for several clients; `addClientsToServerGroup` and `removeClientsFromServerGroup` for group membership; and `addChannelPermissions`, `addChannelGroupPermissions`, `addChannelClientPermissions`, `addClientPermissions`, `addServerGroupPermissions` and `addServerGroupPermissionsByType`, with a `delete…` twin for each, for permission batches. Each sends one command with a row per item. `continueOnError` sends `-continueonerror` on the commands the server documents it for.

The server answers a batch with one status, never one per item, so these resolve to nothing, and each doc comment says what was measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 beta13.1: what a failing item leaves applied, and which error the switch leaves. A permission batch with an unknown permission, an unreadable value or a missing key is refused whole; one with a row the caller lacks the power for is applied in order, stopping at that row, or skipping it with the switch. For kick, move and ban the switch hides the failure, and for group membership it reports the last one.

Docs: `getPermissionIDByName` rejects with error 2562 for a name the server does not know, as it always did; its doc comment said it resolved to `undefined`.
