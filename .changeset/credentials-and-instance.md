---
"@honeybbq/teamspeak": minor
---

The commands that could only be sent as raw lines now have typed functions. API keys: `addAPIKey`, `listAPIKeys`, `deleteAPIKey`. ServerQuery logins: `addQueryLogin`, `listQueryLogins`, `deleteQueryLogin`, and `setQueryLogin` for the voice protocol. Custom client properties: `setCustomProperty`, `deleteCustomProperty`, `listCustomProperties`, `findCustomProperty`. Also `sendOfflineMessage`, `getOwnPermission` (`permget`), and `addServerGroupPermissionByType` and `deleteServerGroupPermissionByType` for every group of a type on every virtual server. The key an API key creation returns, the password of a login and the administrator key of a new server are properties that `console.log`, `util.inspect` and `JSON.stringify` of the result leave out; read them by name.

For an instance administrator over ServerQuery: `listServers`, `createServer`, `startServer`, `stopServer`, `deleteServer`, `stopInstance`, `sendGlobalMessage`, and `createServerSnapshot` and `deployServerSnapshot` with a password, `keepFiles` and the channel mapping. A voice client's Server Admin gets error 2568 for all of them. An unlicensed TS3 or TS6 runs one virtual server, and refuses another with 2816. `APIKeyID` and `asAPIKeyID`, `APIKeyScope` and `GroupAutoUpdateType` come with them.
