# How ServerQuery answers each typed command

Measured against TS3 3.13.8 and TS6 6.0.0-beta13.1 as Server Admin, with every
typed command of the core run through a `QueryClient`. Re-run the measurement
with `scripts/probe-serverquery.mts`. The question it answers is whether a
ServerQuery client can serve the core as it stands, and every difference it
found is sorted into one of four classes:

- **a**: none. The command and its parser work as they are.
- **b**: handled inside the ServerQuery client or its transport.
- **c**: needs an additive change to the core: a field or option added, or a
  value filled that was left empty.
- **d**: needs a breaking change to the core: a field type, a return type, a
  signature, or a field that cannot be filled.

Only **d** blocks 1.0.

## Transports

| Transport | Where                       | TS3                                  | TS6                 | Login           | Events |
| --------- | --------------------------- | ------------------------------------ | ------------------- | --------------- | ------ |
| Raw TCP   | 10011                       | yes                                  | **no**              | `login` command | yes    |
| SSH       | 10022                       | yes (3.3 and later), off by default  | yes, off by default | the SSH login   | yes    |
| WebQuery  | 10080 (HTTP), 10443 (HTTPS) | yes (3.12 and later), off by default | yes                 | `x-api-key`     | no     |

**TS3 serves SSH and WebQuery too, once `query_protocols` lists them.** It is
`raw` alone by default; `raw,ssh,http` turns on all three (the official Docker
image reads it from `TS3SERVER_QUERY_PROTOCOLS`, and the serveradmin password
for SSH from `TS3SERVER_SERVERADMIN_PASSWORD`). Measured on 3.13.8 with the
three on, the same suite passing over each:

- SSH logs in as `serveradmin` with the serveradmin password and presents an RSA
  host key, generated at the first start, as TS6 does. It greets with the same
  two-line banner and takes `use`, not `login`.
- WebQuery accepts both `POST` with a JSON body, which the transport sends, and
  `GET` with the parameters in the query string; `/<sid>/`, `/byport/<port>/`
  and no prefix at all (the first server) address a server. The server prints no
  api key at its first start: create one over raw TCP, `apikeyadd scope=manage
  lifetime=0`. With no key the answer is 401 with code 5124 ("missing apikey"),
  where TS6 serves a guest, and a wrong key is 401 with 5122. A key of `manage`
  scope is still refused `servernotifyregister`, with 5120.
- TS3's WebQuery runs every command on a virtual server, the first one when the
  path names none, so a command that differs between the instance and a server
  has only its server form there: `queryloginadd client_login_name=…` makes a
  global login over raw TCP and SSH with no server selected, and answers 1539
  over WebQuery. An unknown command is 1538 over WebQuery (as on TS6) and 256
  over raw TCP and SSH.
- TS3's SSH server offers `rsa-sha2-512`, `rsa-sha2-256` and `ssh-rsa` for its
  host key and signs the key exchange with `rsa-sha2-512` whichever the client
  chose, so a client that asks for `rsa-sha2-256` first is refused by its own
  library. OpenSSH and `ssh2` agree with it; Go's library needs `rsa-sha2-512`
  put first.
- A TS3 SSH session whose client closes the connection without `quit` can stay
  on the server, as a query client in `clientlist`, for minutes at least; enough of them and the address gets no new connections (an address is
  allowed five at once). The SSH and raw transports therefore say `quit`
  before they close.
- The ServerQuery flood limit and its ban time are `serverinstance_serverquery_flood_*`
  and `serverinstance_serverquery_ban_time`. `serverinstance_serverquery_flood_ban_time`
  is accepted by both servers and changes nothing.

**TS6 does not serve raw TCP.** Nothing listens on 10011 in the container
(its listening sockets are the HTTP query port and the file transfer port),
connecting is refused, and the server's command-line options list SSH, HTTP
and HTTPS query interfaces and no raw one. Port 10011 on the host, in the
setup the probe ran in, is TS3's.

**SSH is off by default on TS6**, as on TS3, and was measured on a second TS6 container
started with `TSSERVER_QUERY_SSH_ENABLED=1`, its own file transfer port and
its own admin password. The session is the query account already, so there is
no `login`, only `use`. It greets with the same two-line banner as raw TCP.
Over SSH, TS6 answers everything TS3 does over raw TCP, with one exception:
`ftstop` for a transfer that is not the query connection's own, one that does
not exist or another client's, crashes the server. A transfer of the
connection's own that has finished, or that nobody connected to for about 10
seconds after it was negotiated, no longer exists either (measured on TS3
3.13.8 and TS6 6.0.0), so stopping it then crashes TS6 too. The log says
`TeamSpeak server has crashed`, and the server answers nothing until the
container restarts. It did so every time, three of three. TS3 answers the same
command with a status row.

Over SSH, TS6 may also hold the last line of a reply, usually
`error id=0 msg=ok`, until the client writes again (about one command in a
thousand under load, mostly with notifications registered). An empty line
releases it and gets no answer of its own, so the SSH transport writes one when
a command has waited 2 seconds, and once a second after.

**WebQuery** frames each command as `POST /<server>/<command>` with the
parameters as JSON, and answers JSON: `body` is the rows and `status` is the
`error` line (`code`, `message`, and sometimes `extra_message`). The transport
turns that back into rows and an `error id=… msg=…` line, so the client sees
one answer shape.

- A refusal is HTTP 200 for most errors (768, 1281, 512) and 400 for some
  (1538 for an unknown command, 7 for an unknown server); the `status.code`
  decides, not the HTTP status.
- A wrong key is 401 and carries a TeamSpeak code (5122), so it is a
  `ServerError`. Only an answer with no code at all is a transport error.
- No key at all is served as a guest (beta13 and later; see
  [Guests](#guests)).
- `login`, `use` and `quit` do not exist. `use` is answered by the transport,
  which changes the server the next requests address.
- The api key the server printed at its first start is refused every `ft*`
  command and `servernotifyregister` with code 5120, "command not in api key
  scope", so TS6's file transfers and events need SSH. The server's own
  documentation lists them as unsupported over WebQuery.
- The global `fetch` refuses port 10080 as a blocked port ("bad port"), so
  the transport uses `node:http`, or `node:https` for an `https:` URL. HTTPS
  needs `https` in `query_protocols` and a certificate and key
  (`query_https_certificate_file`, `query_https_private_key_file`); the
  transport verifies the certificate against Node's trust store, so a private
  CA is trusted through `NODE_EXTRA_CA_CERTS` or a caller-supplied `fetch`.

On the wire, a ServerQuery connection writes `\n\r` after each line, and a
list is one line of rows joined by `|`. Every row carries all its fields: no
row left out a field the row before it had. That is unlike the voice protocol,
whose rows are completed from the row before, so the client does not do that
here. One answer was affected: `logview`, whose rows after the first carry
only `l`.

## Commands

For TS6, the commands that need a file transfer connection give the WebQuery
answer and the SSH answer. A cell lists the keys of the answer row, or how many
there are when the row is wide. **Not found** lists the keys a parser looked
for and the row did not have, which is what a silent `""` or `0` in a parsed
result means.

TS3 and TS6 agree on every command that both serve, row for row, apart from
extra keys on TS6 and the order of the keys.

| Function                        | Command                       | TS3, raw TCP                                                                       | TS6, WebQuery (files: SSH)                                                                    | Not found by the parser                                                                  | Class |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----- |
| `whoAmI`                        | `whoami`                      | 11 keys                                                                            | 12 keys                                                                                       | -                                                                                        | a     |
| `getVersion`                    | `version`                     | `version`, `build`, `platform`                                                     | `build`, `platform`, `version`                                                                | -                                                                                        | a     |
| `getServerInfo`                 | `serverinfo`                  | 100 keys                                                                           | 109 keys                                                                                      | -                                                                                        | a     |
| `getHostInfo`                   | `hostinfo`                    | 18 keys                                                                            | 20 keys                                                                                       | -                                                                                        | a     |
| `getInstanceInfo`               | `instanceinfo`                | 15 keys                                                                            | 16 keys                                                                                       | -                                                                                        | a     |
| `listBindings`                  | `bindinglist`                 | `ip`                                                                               | `ip`                                                                                          | `port`, `subsystem`                                                                      | c     |
| `getConnectionInfo`             | `serverrequestconnectioninfo` | 15 keys                                                                            | 15 keys                                                                                       | -                                                                                        | a     |
| `getServerIDByPort`             | `serveridgetbyport`           | `server_id`                                                                        | `server_id`                                                                                   | -                                                                                        | a     |
| `listServerGroups`              | `servergrouplist`             | 10 keys                                                                            | 10 keys                                                                                       | -                                                                                        | a     |
| `listPermissions`               | `permissionlist`              | `permid`, `permname`, `permdesc`                                                   | `permdesc`, `permid`, `permname`                                                              | -                                                                                        | a     |
| `getPermissionIDByName`         | `permidgetbyname`             | `permsid`, `permid`                                                                | `permid`, `permsid`                                                                           | -                                                                                        | a     |
| `editServer`                    | `serveredit`                  | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `editInstance`                  | `instanceedit`                | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listChannels`                  | `channellist`                 | 18 keys                                                                            | 18 keys                                                                                       | `channel_description`, `channel_unique_identifier`, `cpid`                               | a     |
| `createChannel`                 | `channelcreate`               | `cid`                                                                              | `cid`                                                                                         | -                                                                                        | a     |
| `getChannelInfo`                | `channelinfo`                 | 30 keys                                                                            | 31 keys                                                                                       | `channel_needed_subscribe_power`, `cid`, `cpid`, `total_clients`, `total_clients_family` | d     |
| `editChannel`                   | `channeledit`                 | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `findChannels`                  | `channelfind`                 | `cid`, `channel_name`                                                              | `channel_name`, `cid`                                                                         | -                                                                                        | a     |
| `moveChannel`                   | `channelmove`                 | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `addChannelPermission`          | `channeladdperm`              | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listChannelPermissions`        | `channelpermlist`             | `cid`, `permid`, `permvalue`, `permnegated`, `permskip`                            | `cid`, `permid`, `permnegated`, `permskip`, `permvalue`                                       | `permsid`                                                                                | a     |
| `deleteChannelPermission`       | `channeldelperm`              | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listClients`                   | `clientlist`                  | 26 keys                                                                            | 26 keys                                                                                       | -                                                                                        | a     |
| `getClientProperties`           | `clientinfo`                  | 62 keys                                                                            | 65 keys                                                                                       | -                                                                                        | a     |
| `findClients`                   | `clientfind`                  | `clid`, `client_nickname`                                                          | `clid`, `client_nickname`                                                                     | -                                                                                        | a     |
| `getClientIDs`                  | `clientgetids`                | `cluid`, `clid`, `name`; 1281 when empty                                           | `clid`, `cluid`, `name`; 1281 when empty                                                      | -                                                                                        | a     |
| `getClientUIDByID`              | `clientgetuidfromclid`        | `clid`, `cluid`, `nickname`, `mytsid`                                              | `clid`, `cluid`, `mytsid`, `nickname`                                                         | -                                                                                        | a     |
| `getClientDBIDByUID`            | `clientgetdbidfromuid`        | `cluid`, `cldbid`                                                                  | `cldbid`, `cluid`                                                                             | -                                                                                        | a     |
| `getClientNameByDBID`           | `clientgetnamefromdbid`       | `cluid`, `cldbid`, `name`                                                          | `cldbid`, `cluid`, `name`                                                                     | -                                                                                        | a     |
| `getClientNameByUID`            | `clientgetnamefromuid`        | `cluid`, `cldbid`, `name`                                                          | `cldbid`, `cluid`, `name`                                                                     | -                                                                                        | a     |
| `getClientDatabaseInfo`         | `clientdbinfo`                | 14 keys                                                                            | 14 keys                                                                                       | `cldbid`                                                                                 | a     |
| `editClientDatabase`            | `clientdbedit`                | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `findClientDatabase`            | `clientdbfind`                | `cldbid`; 1281 when empty                                                          | `cldbid`; 1281 when empty                                                                     | -                                                                                        | a     |
| `findClientDatabaseByUID`       | `clientdbfind`                | `cldbid`; 1281 when empty                                                          | `cldbid`; 1281 when empty                                                                     | -                                                                                        | a     |
| `listClientDatabase`            | `clientdblist`                | 9 keys                                                                             | 9 keys                                                                                        | -                                                                                        | a     |
| `moveClient`                    | `clientmove`                  | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `editClient`                    | `clientedit`                  | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `updateClient`                  | `clientupdate`                | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `pokeClient`                    | `clientpoke`                  | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `sendPrivateMessage`            | `sendtextmessage`             | ok                                                                                 | 7 keys                                                                                        | -                                                                                        | a     |
| `sendChannelMessage`            | `sendtextmessage`             | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `sendServerMessage`             | `sendtextmessage`             | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listClientPermissions`         | `clientpermlist`              | `cldbid`, `permid`, `permvalue`, `permnegated`, `permskip`; 1281 when empty        | `cldbid`, `permid`, `permnegated`, `permskip`, `permvalue`; 1281 when empty                   | `permsid`                                                                                | a     |
| `addClientPermission`           | `clientaddperm`               | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `deleteClientPermission`        | `clientdelperm`               | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listChannelClientPermissions`  | `channelclientpermlist`       | `cid`, `cldbid`, `permid`, `permvalue`, `permnegated`, `permskip`; 1281 when empty | `cid`, `cldbid`, `permid`, `permnegated`, `permskip`, `permvalue`; 1281 when empty            | `permsid`                                                                                | a     |
| `addChannelClientPermission`    | `channelclientaddperm`        | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `getPermissionOverview`         | `permoverview`                | 7 keys                                                                             | 7 keys                                                                                        | -                                                                                        | a     |
| `findPermission`                | `permfind`                    | `t`, `id1`, `id2`, `p`                                                             | `id1`, `id2`, `p`, `t`                                                                        | -                                                                                        | a     |
| `deleteChannelClientPermission` | `channelclientdelperm`        | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `createServerGroup`             | `servergroupadd`              | `sgid`                                                                             | `sgid`                                                                                        | `name`                                                                                   | a     |
| `renameServerGroup`             | `servergrouprename`           | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `copyServerGroup`               | `servergroupcopy`             | `sgid`                                                                             | `sgid`                                                                                        | `name`                                                                                   | a     |
| `addServerGroupPermission`      | `servergroupaddperm`          | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listServerGroupPermissions`    | `servergrouppermlist`         | `sgid`, `permid`, `permvalue`, `permnegated`, `permskip`                           | `permid`, `permnegated`, `permskip`, `permvalue`, `sgid`                                      | `permsid`                                                                                | a     |
| `deleteServerGroupPermission`   | `servergroupdelperm`          | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listServerGroupClients`        | `servergroupclientlist`       | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `addClientToServerGroup`        | `servergroupaddclient`        | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `getServerGroupsByClient`       | `servergroupsbyclientid`      | `name`, `sgid`, `cldbid`                                                           | `cldbid`, `name`, `sgid`                                                                      | -                                                                                        | a     |
| `removeClientFromServerGroup`   | `servergroupdelclient`        | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `deleteServerGroup`             | `servergroupdel`              | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `createChannelGroup`            | `channelgroupadd`             | `cgid`                                                                             | `cgid`                                                                                        | `name`                                                                                   | a     |
| `renameChannelGroup`            | `channelgrouprename`          | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `copyChannelGroup`              | `channelgroupcopy`            | `cgid`                                                                             | `cgid`                                                                                        | `name`                                                                                   | a     |
| `addChannelGroupPermission`     | `channelgroupaddperm`         | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listChannelGroupPermissions`   | `channelgrouppermlist`        | `cgid`, `permid`, `permvalue`, `permnegated`, `permskip`                           | `cgid`, `permid`, `permnegated`, `permskip`, `permvalue`                                      | `permsid`                                                                                | a     |
| `deleteChannelGroupPermission`  | `channelgroupdelperm`         | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listChannelGroupClients`       | `channelgroupclientlist`      | `cid`, `cldbid`, `cgid`; 1281 when empty                                           | `cgid`, `cid`, `cldbid`; 1281 when empty                                                      | -                                                                                        | a     |
| `setClientChannelGroup`         | `setclientchannelgroup`       | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `deleteChannelGroup`            | `channelgroupdel`             | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listChannelGroups`             | `channelgrouplist`            | 10 keys                                                                            | 10 keys                                                                                       | -                                                                                        | a     |
| `listBans`                      | `banlist`                     | 13 keys; 1281 when empty                                                           | 13 keys; 1281 when empty                                                                      | -                                                                                        | a     |
| `addBan`                        | `banadd`                      | `banid`                                                                            | `banid`                                                                                       | -                                                                                        | a     |
| `deleteBan`                     | `bandel`                      | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `deleteAllBans`                 | `bandelall`                   | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `banClient`                     | `banclient`                   | `banid`                                                                            | `banid`                                                                                       | -                                                                                        | a     |
| `listComplaints`                | `complainlist`                | `tcldbid`, `tname`, `fcldbid`, `fname`, `message`, `timestamp`; 1281 when empty    | `fcldbid`, `fname`, `message`, `tcldbid`, `timestamp`, `tname`; 1281 when empty               | -                                                                                        | a     |
| `addComplaint`                  | `complainadd`                 | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `deleteComplaint`               | `complaindel`                 | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `deleteAllComplaints`           | `complaindelall`              | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listMessages`                  | `messagelist`                 | 1281 (empty)                                                                       | 1281 (empty)                                                                                  | -                                                                                        | a     |
| `getMessage`                    | `messageget`                  | not measured                                                                       | not measured                                                                                  | -                                                                                        | -     |
| `updateMessageFlag`             | `messageupdateflag`           | not measured                                                                       | not measured                                                                                  | -                                                                                        | -     |
| `deleteMessage`                 | `messagedel`                  | not measured                                                                       | not measured                                                                                  | -                                                                                        | -     |
| `viewLog`                       | `logview`                     | `last_pos`, `file_size`, `l`                                                       | `file_size`, `l`, `last_pos`                                                                  | `log`                                                                                    | a     |
| `addLog`                        | `logadd`                      | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listPrivilegeKeys`             | `privilegekeylist`            | 7 keys                                                                             | 7 keys                                                                                        | -                                                                                        | a     |
| `addPrivilegeKey`               | `privilegekeyadd`             | `token`                                                                            | `token`                                                                                       | -                                                                                        | a     |
| `usePrivilegeKey`               | `privilegekeyuse`             | error 516                                                                          | error 516                                                                                     | -                                                                                        | a     |
| `deletePrivilegeKey`            | `privilegekeydelete`          | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listTempPasswords`             | `servertemppasswordlist`      | 8 keys; 1281 when empty                                                            | 8 keys; 1281 when empty                                                                       | -                                                                                        | a     |
| `addTempPassword`               | `servertemppasswordadd`       | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `deleteTempPassword`            | `servertemppassworddel`       | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `listFiles`                     | `ftgetfilelist`               | `cid`, `path`, `name`, `size`, `datetime`, `type`; 1281 when empty                 | WebQuery: error 5120; SSH: `cid`, `path`, `name`, `size`, `datetime`, `type`; 1281 when empty | -                                                                                        | a / b |
| `createDirectory`               | `ftcreatedir`                 | ok                                                                                 | WebQuery: error 5120; SSH: ok                                                                 | -                                                                                        | a / b |
| `initFileUpload`                | `ftinitupload`                | `clientftfid`, `serverftfid`, `ftkey`, `port`, `seekpos`, `proto`                  | WebQuery: error 5120; SSH: `clientftfid`, `serverftfid`, `ftkey`, `port`, `seekpos`, `proto`  | -                                                                                        | b     |
| `getFileInfo`                   | `ftgetfileinfo`               | `cid`, `name`, `size`, `datetime`                                                  | WebQuery: error 5120; SSH: `cid`, `name`, `size`, `datetime`                                  | `type`                                                                                   | a / b |
| `initFileDownload`              | `ftinitdownload`              | `clientftfid`, `serverftfid`, `ftkey`, `port`, `size`, `proto`                     | WebQuery: error 5120; SSH: `clientftfid`, `serverftfid`, `ftkey`, `port`, `size`, `proto`     | -                                                                                        | b     |
| `renameFile`                    | `ftrenamefile`                | ok                                                                                 | WebQuery: error 5120; SSH: ok                                                                 | -                                                                                        | a / b |
| `deleteFile`                    | `ftdeletefile`                | ok                                                                                 | WebQuery: error 5120; SSH: ok                                                                 | -                                                                                        | a / b |
| `listActiveTransfers`           | `ftlist`                      | 1281 (empty)                                                                       | WebQuery: error 5120; SSH: 1281 (empty)                                                       | -                                                                                        | a / b |
| `stopFileTransfer`              | `ftstop`                      | `clientftfid`, `status`, `msg`, `size`                                             | not measured (crashes the server over SSH)                                                    | -                                                                                        | a / - |
| `resetPermissions`              | `permreset`                   | not measured                                                                       | not measured                                                                                  | -                                                                                        | -     |
| `deleteClientDatabase`          | `clientdbdelete`              | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `iterateClientDatabase`         | `clientdblist`                | 9 keys                                                                             | 9 keys                                                                                        | -                                                                                        | a     |
| `deleteChannel`                 | `channeldelete`               | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |
| `kickClient`                    | `clientkick`                  | ok                                                                                 | ok                                                                                            | -                                                                                        | a     |

All 106 typed functions were called. `deleteAllBans` ran only because every ban
on the server was the probe's own. `resetPermissions` was skipped, as it resets
the whole server. `editServer` and `editInstance` were called with a value
equal to the current one.

### Commands added after the table

Measured the same way, against TS3 3.13.8 over raw TCP and TS6 6.0.0-beta13.1
over WebQuery and SSH, on a TS3 and a TS6 of their own for the instance-level
ones. The rows are the same across transports apart from key order, and `count`
(from `-count`, which the SDK does not send) on the first row only.

| Function                                                              | Command                                                          | Answer                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addAPIKey`, `listAPIKeys`, `deleteAPIKey`                            | `apikeyadd`, `apikeylist`, `apikeydel`                           | `apikey`, `id`, `sid`, `cldbid`, `scope`, `time_left`, `created_at`, `expires_at`; TS6 adds `custom_id`; 1281 when empty                                                                                                                                                                                                                        |
| `sendOfflineMessage`                                                  | `messageadd`                                                     | ok; 512 for an unknown uid; needs `b_client_offline_textmessage_send`, which the command reference does not list                                                                                                                                                                                                                                |
| `setCustomProperty`, `deleteCustomProperty`                           | `customset`, `customdelete`                                      | ok, also for a `cldbid` that does not exist                                                                                                                                                                                                                                                                                                     |
| `listCustomProperties`, `findCustomProperty`                          | `custominfo`, `customsearch`                                     | `ident`, `value`, and `cldbid` on every row of a search but only the first row of `custominfo`; see below                                                                                                                                                                                                                                       |
| `addQueryLogin`, `deleteQueryLogin`, `listQueryLogins`                | `queryloginadd`, `querylogindel`, `queryloginlist`               | `cldbid`, `sid`, `client_login_name`, and `client_login_password` for an add; 1281 when empty                                                                                                                                                                                                                                                   |
| `setQueryLogin`                                                       | `clientsetserverquerylogin`                                      | 512 over every query transport; over voice `client_login_password`                                                                                                                                                                                                                                                                              |
| `getOwnPermission`                                                    | `permget`                                                        | `permsid`, `permid`, `permvalue`; 2562 for an unknown permission                                                                                                                                                                                                                                                                                |
| `addServerGroupPermissionByType`, `deleteServerGroupPermissionByType` | `servergroupautoaddperm`, `servergroupautodelperm`               | ok                                                                                                                                                                                                                                                                                                                                              |
| `listServers`                                                         | `serverlist`                                                     | `virtualserver_id`, `_port`, `_status`, and unless `-short` `_clientsonline`, `_queryclientsonline`, `_maxclients`, `_uptime`, `_name`, `_autostart`, `_machine_id`; `_unique_identifier` with `-uid`; TS6 adds `guest_can_create_channels`, `guest_can_create_homebase`, `virtualserver_weblist_enabled`, and `virtualserver_uuid` with `-uid` |
| `createServer`                                                        | `servercreate`                                                   | `sid`, `virtualserver_port`, `token`                                                                                                                                                                                                                                                                                                            |
| `startServer`, `stopServer`, `deleteServer`, `stopInstance`           | `serverstart`, `serverstop`, `serverdelete`, `serverprocessstop` | ok; 1033 stopping a stopped server; 1035 deleting one a query client has selected; 1024 for an unknown id                                                                                                                                                                                                                                       |
| `sendGlobalMessage`                                                   | `gm`                                                             | ok                                                                                                                                                                                                                                                                                                                                              |
| `createServerSnapshot`, `deployServerSnapshot`                        | `serversnapshotcreate`, `serversnapshotdeploy`                   | `version`, `data`, and `salt` with a password; a deploy with `-mapping` answers `ocid`, `ncid` per channel                                                                                                                                                                                                                                      |
| `findBans`                                                            | `banfind`                                                        | the `banlist` row; TS6 only, and unknown (1538) over WebQuery                                                                                                                                                                                                                                                                                   |

What the table does not say:

- **A new server of an unlicensed instance.** Both TS3 and TS6 refuse a second
  running virtual server with 2816 (virtualserver limit reached): in `servercreate`
  and in `serverstart`, and in `serversnapshotdeploy` with no server selected, which
  creates a new one from the snapshot and leaves it stopped. A test of the lifecycle
  therefore stops and deletes server 1 and creates its replacement.
- **A deploy ends the selection.** Over raw TCP and SSH the next command after
  `serversnapshotdeploy` answers 1024 (invalid serverID) until `use` runs again. The
  channels get new ids.
- **SSH has no instance level on TS6, nor on TS3.** Connecting with no server selected fails with
  1024 (invalid serverID). A connection selects server 1 and runs the
  instance-level commands from there; WebQuery addresses the instance directly.
- **`custominfo` for a client with no properties** answers 512, as for a client that
  does not exist.
- **`tokencustomset`** is escaped twice: the documentation's example, escaped once,
  gives a value cut at its first space.
- **Logging out** (`logout`) leaves the connection open with no server selected and no
  login; over WebQuery the server refuses it, and `servernotifyunregister`, with 5120.
- **A deleted API key** can be the one a WebQuery connection uses: deleting the key a
  server printed at its first start ends that access.

### Guests

TS6 beta13 accepts a guest ServerQuery login without any setup, protected by the
Guest Server Query group's permissions. Measured on 6.0.0-beta13.1.

- **SSH.** The user `guest` is accepted with no password, with an empty
  password, with any password, and by keyboard-interactive. The session starts
  with no server selected, like any other; after `use 1`, `version` and `whoami`
  answer, and `serverinfo`, `serverlist`, `clientlist` and `instanceinfo` answer
  2568 with `failed_permid` 26, 3, 30 and 2. `servernotifyregister` for
  `textprivate` answers 2568 (`failed_permid=48`), so a guest that is not given
  that permission connects with `events: false`. A guest may `login` as another
  account over the session. The switch is `--query-ssh-allow-guest` (default
  1. or `TSSERVER_QUERY_SSH_ALLOW_GUEST`.
- **WebQuery.** A request with no `x-api-key` header, with an empty one, or with
  an empty `api-key` parameter runs in the guest scope: `version`, `whoami`,
  `channellist` and `clientlist` answer, a permission-gated command such as
  `hostinfo` answers 2568 with `failed_permission` (HTTP 200; the client
  keeps it as `ServerError.failedPermission`, a name, never mapped to an id), and a command
  outside the scope (`serverinfo`, `apikeylist`, `servergrouplist`,
  `channelfind`, `clientfind`) answers HTTP 401 with code 5120 and
  `extra_message` "command not allowed for guest access". A wrong key is not a
  guest: HTTP 401, code 5122. The switch is `--query-http-allow-guest`
  (default 1) or `TSSERVER_QUERY_HTTP_ALLOW_GUEST`.
- **Flood limit.** The query flood limit applies to a guest's address like any
  other: a guest that sends several commands a second is answered 524 ("client
  is flooding") until it waits.

The client connects as a guest only when told to, with `guest: true` on the
`ssh` and `web` transports; a missing `username`, `password` or `apiKey` is an
error and never a guest.

### Documented TS6 commands that this server answers 256

The command reference lists these, and `help` lists `authenticationtoken` and
`chatlogintoken`, but beta13.1 answers `error id=256 msg=command not found` to
each of them over SSH as `serveradmin` (and, measured earlier, over voice and
WebQuery). The documented parameters change nothing. No function is typed for
them.

| Command                      | Tried                                                                                                    | Answer |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| `authenticationtoken`        | `authenticationtoken duration=60`                                                                        | 256    |
| `chatlogintoken`             | `chatlogintoken`                                                                                         | 256    |
| `homebaseset`                | `homebaseset`, `homebaseset cldbid=1`                                                                    | 256    |
| `homebaseisset`              | `homebaseisset`, `homebaseisset cldbid=1`                                                                | 256    |
| `homebasedel`                | `homebasedel`, `homebasedel cldbid=1`                                                                    | 256    |
| `homebaselist`               | `homebaselist`                                                                                           | 256    |
| `clientdblist -homebaseonly` | accepted without error, but the filter is not applied: the whole list comes back, with no homebase field | 0      |

The permissions the documentation names for them, such as
`b_virtualserver_homebase_set`, do not exist on this server: `permget` and
`permidgetbyname` answer 2562.

### Counts

| Class        | TS3 | TS6 |
| ------------ | --- | --- |
| a            | 98  | 91  |
| b            | 2   | 8   |
| c            | 1   | 1   |
| d            | 1   | 1   |
| not measured | 4   | 5   |

On TS6, six of the eight **b** are file commands that WebQuery cannot serve
and SSH can; the other two, like the two on TS3, are the transfer negotiations
(below). The **not measured** are `getMessage`, `updateMessageFlag`,
`deleteMessage` and `resetPermissions` on both, and `stopFileTransfer` on TS6.
No offline message reaches the query account to read: `messageadd` to its own
unique identifier answers 512 on both servers, and `messagelist` stays empty.

### What is class a, and why it needs no change

- **Empty answers.** Every list that has nothing to list answers 1281, and
  `list()` reads it as `[]`. `findChannels` with no match answers 768 and
  `findClients` 512, which `list()` also reads as `[]`. `getClientIDs` for an
  unknown identifier answers 1281, `findClientDatabase` 1281. All three
  behave as `list()` expects, on both servers and over every transport.
- **Fields the answer leaves out by design.** `channellist` has no `cpid`
  (the parser reads `pid`), no `channel_description` and no
  `channel_unique_identifier`, as `listChannels` documents. `channelinfo` has
  no `cid`, `clientdbinfo` no `cldbid`, and the parsers take the id from the
  argument. The permission lists answer `permid`, not `permsid`, which
  `parsePermission` reads. `servergroupadd` and its copies answer `sgid`
  alone, so `createdGroupID` takes it. `logview` answers `l` rows, not `log`.
  `ftgetfileinfo` has no `type`, so `isDirectory` is false; asked about a
  directory it answers 2048, invalid file name, while `ftgetfilelist` lists it
  with `type=0`.
- **Timestamps.** TS6 answers `ftgetfilelist`'s `datetime` in milliseconds and
  TS3 in seconds, which `date()` already tells apart.
- **Creates return their id.** `createChannel` (`cid`), `createServerGroup`
  and its copy (`sgid`), `createChannelGroup` and its copy (`cgid`), `addBan`
  and `banClient` (`banid`, two rows for `banClient`, one per ban it made) and
  `addPrivilegeKey` (`token`) all answer with a nameless row, as the official
  examples show. `addTempPassword` answers nothing and returns nothing.
- **Answers a typed function ignores.** TS6 over WebQuery answers
  `sendtextmessage` for a private message with a row holding the message's own
  fields, `notifytextmessage` among them; `sendPrivateMessage` returns
  nothing, so it does not matter. On TS3, `ftstop` for an unknown transfer
  answers `error id=0` and a row with `status=2066`, and `stopFileTransfer`
  reads that as success.
- **Not served to a query client.** `usePrivilegeKey` answers 516, invalid
  client type, to a query client on both servers; a voice client's call
  succeeds. The same 516 answers `pokeClient` and `kickClient` aimed at a query
  client, except a channel kick (`reasonid=4`), which is accepted and arrives as
  a move.
- **A short first page of a paged walk.** `clientdblist` returns at most 200
  rows however many `duration` asks for, and with no arguments 25. See Paging.
- **TS6 creates that came back without an id.** TS6 over WebQuery answers
  `channelcreate`, `channelgroupadd`, `channelgroupcopy`, `servergroupadd` and
  `servergroupcopy` with `ok` and no row, in 2 to 75% of the creates of a run,
  whenever a Server Admin voice client is connected. The server had made the
  object. Over SSH the same conditions put the id row after the `error` line in
  24 to 28% of the answers, which the late-row hold recovers; over HTTP the
  response has closed by then. On a quiet server, or with a plain voice client,
  every transport returned the id, TS3 is unaffected on every transport, and
  voice is unaffected on both. The server's own docs say each command returns
  the id. See "Server behaviour the SDK works around".

### Class b

- **File transfer negotiation.** `ftinitupload` and `ftinitdownload` answer
  inline, in nameless rows, on both servers: nothing arrives as a correlated
  notification, as it does over the voice protocol. A refusal arrives the same
  way, in the row and not in the `error` line, which says `id=0`: a file that
  does not exist is `clientftfid=902 status=2051 msg=file\snot\sfound`, with
  no `ftkey`, and a name already being transferred is `status=2058`. The typed
  functions would report "no data". `QueryClient` reads such a row as the
  `ServerError` it is. The keys it returns are the keys the parsers read:
  `ftkey`, `port`, `clientftfid`, `serverftfid`, and `seekpos` or `size`. The
  transfer connection itself, `uploadFileData` and `downloadFileData`, worked
  with a key from a `QueryClient` on both servers, and a file written came back
  byte for byte. The answers carry no `ip` (nor does the voice protocol's), so
  the transfer port is dialled on the host the connection uses. A download with
  `seekpos` answers the whole `size` and sends `size - seekpos` bytes. After an
  upload's last byte the server closes the transfer connection about 200 ms
  later, and at once when more than the declared size is sent; an interrupted
  upload leaves the partial file, which `resume=1` continues from the `seekpos`
  it answers (`overwrite` with it is 2056, a missing file 2054).
- **Row completion.** The client must not complete a row from the row before.
- **File commands on TS6.** WebQuery refuses all of them, so a ServerQuery
  client of TS6 needs SSH for any of them.
- **`login` and `use`.** Raw TCP needs both, SSH only `use`, WebQuery
  neither: the key is the login, and the transport keeps the server.

### Class c

- **`listBindings`** (`src/core/api/server.ts`). `bindinglist` answers `ip`
  and nothing else, on both servers, so `subsystem` was `""` and `port` 0 for
  every row. The server lists only the voice bindings unless asked for another
  subsystem, and the option's doc comment says an unset subsystem lists all.
  This was fixed with the signature unchanged: `listBindings` fills `subsystem`
  from `options.subsystem ?? "voice"`, and `port` is left undefined, as the
  server does not report one.

## Events

Notifications reach `QueryClient.onNotification` as the server sent them, so
this is whether each event type of the core can be filled from one. Only TS3
over raw TCP and TS6 over SSH can: WebQuery refuses `servernotifyregister`.
Registering for `server`, `channel` (id 0), `textserver`, `textchannel` and
`textprivate` was accepted on both. `bans` is accepted on TS6 and refused on
TS3 with 1539. The two servers' notifications are alike; TS6 adds `cfid` to a
move and a few client fields. Notifications arrived one per line in every
test, never batched with `|`.

| Event              | Notification                                         | Filled from it                                                                                                                                                        | Not in it                                                                                                                                  | Class |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `TextMessageEvent` | `notifytextmessage`                                  | `invokerName`, `invokerUID`, `message`, `targetMode`, `invokerID`, and `targetID` for a private message                                                               | `invokerGroups`; and `target` for a channel or server message, which the type says is 0                                                    | b     |
| `ClientMovedEvent` | `notifyclientmoved`                                  | `clientID` (`clid`), `targetChannelID` (`ctid`), `reason` (`reasonid`), and the three `invoker` fields when someone else moved the client (`reasonid` 1 or 4)         | the three `invoker` fields when the client moved itself (`reasonid=0`); `reasonmsg` arrives with a kick, and the event has no field for it | b     |
| `ClientLeaveEvent` | `notifyclientleftview`                               | `clientID`, `reason`, `reasonMessage` (`reasonmsg`), and the three `invoker` fields for a kick (`reasonid=5`)                                                         | `reasonid`, `reasonmsg` and the `invoker` fields on a plain disconnect, which the type documents as empty then                             | a     |
| `KickedEvent`      | `notifyclientmoved` with `reasonid=4`                | all five fields: `reason`, `reasonMessage` (`reasonmsg`), `invokerName`, `invokerUID`, `invokerID`                                                                    | nothing, for a channel kick; a kick from the server cannot be sent to a query client                                                       | a     |
| `ClientEnterEvent` | `notifycliententerview`, 38 fields on TS3, 40 on TS6 | `id` (`clid`), `nickname`, `uid`, `channelID` (`ctid`, which the parser falls back to), `type`, `serverGroups`, `isAway`, `isRecording`, `isTalker`, `channelGroupID` | `createdAt`, `lastConnectedAt` and `idleTimeMs`, which the type says are undefined here                                                    | a     |
| `PokeEvent`        | none                                                 | none                                                                                                                                                                  | a query client is never poked: `clientpoke` aimed at one answers 516, on both servers                                                      | a     |
| `VoiceDataEvent`   | none                                                 | none                                                                                                                                                                  | voice only                                                                                                                                 | a     |

The notifications were fed through the voice client's own parser. The keys it
looked for and did not find, across all of them, are the ones the table puts
under "Not in it".

- **`ClientMovedEvent`'s `invoker` fields on a move of the client's own.** The
  type says "the client itself", and a ServerQuery notification names no
  invoker then, so the parser reads `""` and 0. A client fills them from the
  client it knows by `clid`, as it fills `invokerGroups`, which is why this is
  class b.
- **`KickedEvent` for a server kick cannot happen.** `clientkick` with
  `reasonid=5` aimed at a query client answers 516 whoever sends it, so a query
  client is never kicked from the server. A channel kick is accepted, and the
  query client stays connected, moved to the default channel.
- **`invokerGroups`.** A text message carries no groups. A ServerQuery client
  fills them as the voice client does, from the client it learned of in a
  `notifycliententerview` or `clientlist -groups`. It sees an enter only for
  clients that arrive after it registered, so it has to list the ones already
  there. Until it has seen the sender, `invokerGroups` is `undefined`.
- **`ClientLeaveEvent.reason` on a plain disconnect.** The notification has no
  `reasonid`, so `reason` is 0. The voice client reads the same 0 from the same
  disconnect, so the two agree.
- **Not measured.** The leave of a banned client (`reasonid=6`). A private
  message from a voice client to the query client: the voice client was refused
  with 2568, insufficient permissions, so the only private message seen is one
  query client to another, which carried `target`. `tokenused` notifications,
  a category no server here lists. Events over WebQuery, which has none to
  measure.

### Notifications only a voice client receives

A query client registered for all five categories, next to two voice clients
in one channel, with an admin query connection acting. TS3 was raw TCP, TS6 was
SSH on a server started with `TSSERVER_QUERY_SSH_ENABLED=1`. The same action
reached the voice clients on both servers; the table is whether the query
connection saw it.

| Notification                                            | Action that sent it                                              | TS3 raw query | TS6 SSH |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | ------- |
| `notifyclientupdated`                                   | a client set itself away; a group added; a talk power            | no            | no      |
| `notifyservergroupclientadded` / `...deleted`           | `servergroupaddclient` / `servergroupdelclient`                  | no            | no      |
| `notifyclientchannelgroupchanged`                       | `setclientchannelgroup`; a move                                  | no            | no      |
| `notifychannelsubscribed` / `notifychannelunsubscribed` | a voice client's `channelsubscribe` / `channelunsubscribe`       | no            | no      |
| `notifyplugincmd`                                       | a voice client's `plugincmd`, in all three target modes          | no            | no      |
| `notifyclientchatcomposing`                             | a voice client's `clientchatcomposing` aimed at the query client | no            | no      |

A query client cannot send the commands behind the last three either:
`channelsubscribe` and `clientchatcomposing` answer 256, `command not found`,
and `plugincmd` answers 516, `invalid client type`. The notifications a query
client does receive were the same on both servers: `notifychannelcreated`,
`...edited`, `...moved`, `...deleted`, `...descriptionchanged`,
`...passwordchanged` (all under `channel`), `notifyserveredited` (under
`server`), and `notifyclientmoved`.

`notifyserveredited` carries `reasonid=10` on TS3 and no `reasonid` on TS6; a
change of the welcome message carries no property key on either.

### `reasonid=9` on `notifychanneledited`

`channelgetdescription` is answered with `notifychanneledited` holding `cid`,
`channel_description` and `reasonid=9`, and no invoker. Every real edit measured
carried `reasonid=10` and an invoker. What else was tried, on TS3 and TS6:

| Trigger                                                                | What the server sent                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| the caller fetches a description (empty or not)                        | to the caller only: the invoker-less `reasonid=9` edit                            |
| another client fetches it                                              | nothing to anyone else, query client included                                     |
| a client subscribes, unsubscribes, subscribes to all, unsubscribes all | `notifychannelsubscribed` / `...unsubscribed` only                                |
| a client moves into a channel it was not in, or is moved               | `notifyclientmoved` and a channel group change; no channel notification           |
| a channel permission changes (join, subscribe, description view power) | nothing; a subscribe power above the client's unsubscribes it (`...unsubscribed`) |
| a fetch without the description view power                             | error 2568, no notification                                                       |
| `channeledit` (topic, name, description, password, limits)             | `reasonid=10` with the invoker, to every client and the query client              |
| `channelmove`                                                          | `notifychannelmoved` with `reasonid=1` and the invoker                            |

No channel view power exists in either permission list, so a channel never
comes into view by a permission change. No real change arrived as an
invoker-less `reasonid=9`.

### `plugincmd` and the private chat commands

The same two voice clients, plus two in another channel, one subscribed to the
first channel and one not. Identical on TS3 and TS6.

| `targetmode` | Who received `notifyplugincmd`                                                 |
| ------------ | ------------------------------------------------------------------------------ |
| 0            | the sender's channel, the sender included                                      |
| 1            | every client on the server, the sender included                                |
| 2            | the client in `target` only; the sender receives it only when it is the target |
| 3            | every client on the server, as 1; indistinguishable from it                    |
| 4            | refused, 1538                                                                  |

A `targetmode=2` command without `target` is refused with 1539, and with an
unknown one with 512. Empty `data` is delivered. `clientchatcomposing` reaches
the target client only, in any channel, and the sender when it names itself.
`clientchatclosed` reaches the target only when the sender had sent it a private
message first; without one nothing arrives and no error is raised.

## Passwords

A channel password goes over ServerQuery as it is, and the server hashes it.
Measured on both servers and every transport, with a channel created over
ServerQuery with a cleartext password that has spaces, `$` and `|` in it:

- The channel reports `hasPassword`, and a voice client that moves in with a
  wrong password is refused with 781, and with none, 781 as well.
- The same voice client moving in with the cleartext password, through
  `moveClient`'s `password` option, joins. After `editChannel` sets a new
  password, the new one joins; `editChannel` with `password: ""` clears it.
- A temporary server password works. With the server password set to one value,
  a voice client connecting with no password is refused with 1028, with the
  server password connects and lands in the default channel, and with the
  temporary password connects and lands in the temporary password's target
  channel. `listTempPasswords` reports the password in cleartext (`pw_clear`).
  The server password and the temporary password were deleted afterwards, and
  the server reports no password again.

## File transfers

Over raw TCP on TS3 and over SSH on TS6, `ftinitupload` and `ftinitdownload`
answer inline, as above; no correlated notification follows, so a client
waiting for one would wait for nothing. The server picks the port: 30033 on
TS3 and the configured one on TS6. A transfer that was negotiated and never
dialled shows in `ftlist` for about 10 seconds and is then gone, as one that
has finished is; `ftstop` removes it before that. A second
upload of the same name while the first is open answers 2058 in the row.

Measured on TS3 3.13.8 and TS6 6.0.0, over the voice protocol and ServerQuery:

- A transfer that was negotiated and never dialled is dropped by the server
  after about 10 s (gone from `ftlist` at 10.05 s on TS3), and the voice client
  then hears `notifystatusfiletransfer` with 2059. `ftstop` clears it at once.
  `uploadFile` and `downloadFile` send it when the TCP connect to the transfer
  port is refused or times out within 5 s of the negotiation, never once the
  connection opened, and never later, since `ftstop` of a transfer the server
  no longer has crashes TS6.
- A completed upload is never reported: no `notifystatusfiletransfer` for it
  (2065 does not come), and ServerQuery sends nothing about transfers, with
  notifications registered or not. Failures are reported to the voice client
  only, after the connection closed: 2066 canceled (its own `ftstop`, size
  sent so far), 2063 lost connection (the client dropped it), 2052 for more
  bytes than declared (the file stays at the declared size, whole), 2059 as
  above. Refusals come at the negotiation, as 2568 (upload power), 2069
  (`i_ft_quota_mb_upload_per_client`) and 2068 (`virtualserver_upload_quota`);
  permissions are not checked again once negotiated, and
  `virtualserver_storage_quota` does not touch channel files.
- On TS3 an `ftstop` from another connection does nothing: `error id=0`, and
  the transfer goes on. On TS6 it crashes the server.
- `ftgetfileinfo` answers the final size 6 to 45 ms after the close in every
  case: 100000 for a completed upload, 40000 for one stopped at 40000. A client
  without browse power gets 2568; a missing file is 2052 on TS3 and 2051 on TS6.
  `uploadFile` asks for it before it resolves, and fails when the size is not
  the size sent.

## Paging

`clientdblist` pages with `start` and `duration`, as the core's walk expects.
The server caps a page at 200 rows however many were asked for, and a bare
`clientdblist` answers 25. `iterateClientDatabase` therefore sees a short first
page and asks again, as it documents. Measured with page sizes 100 and 1000 on
each server, against databases of 1759 (TS3), 704 and 69 (the two TS6) clients:

- Every walk was in order, with no id twice, and found every client.
- With a page size of 1000 the walk is pages of 200. It ends on a short last
  page on TS3 and the larger TS6, and on 1281 on the database smaller than one
  page, where the short first page does not end it.
- `start` past the end answers 1281, and so does `duration=0`.

## Server behaviour the SDK works around

The SDK does not fix the server, and it never makes up data on the server's
behalf: when it cannot know something it throws a typed error that says so. A
lookup by a unique key is not made-up data: it reads back what the server did.
A workaround for server behaviour stays only while it is harmless on a
correct server, small and in one place, documented with the server version where
the behaviour was measured, and pinned by a test. Each one is removable when a
server release no longer shows the behaviour, re-measured.

| Server and version                 | What the SDK does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                            | Pinned by                                                                                                                                                                                                 | Removable when                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| TS6 6.0.0-beta13.1, SSH            | The server can hold back the last line of a reply until the client writes. The SSH transport writes an empty line once a command has waited 2 s, then every second.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `SSH_NUDGE_AFTER_MS`, `SSH_NUDGE_EVERY_MS` and `#execNow` in `src/query/client.ts`                               | `src/query/ssh-nudge.test.ts`                                                                                                                                                                             | a TS6 release no longer holds a reply over SSH                    |
| TS6 6.0.0-beta13.1, SSH            | The server can write a create's answer rows after its `error` line. The answer is held briefly, and the next command is not sent until it is complete, so a row never reaches the wrong command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `src/query/late-rows.ts`, and its use in `src/query/client.ts`                                                   | `src/query/late-rows.test.ts`; live `src/query/late-rows.integration.test.ts`                                                                                                                             | a TS6 release writes every row before the `error` line over SSH   |
| TS3 3.13.8, SSH                    | The server signs its SSH host key with `rsa-sha2-512` only. Nothing is done in code: `ssh2` already offers `rsa-sha2-512` ahead of `rsa-sha2-256`, so the handshake agrees. The Go SDK has to reorder its algorithms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                                                                                             | the SSH runs of `src/query/integration.test.ts` against TS3                                                                                                                                               | not applicable, there is nothing to remove                        |
| TS3 3.13.8, SSH then any transport | The server resets a connection made within a few milliseconds of an SSH session closing (4 to 14 in 100 requests, none from 3 ms on). The SDK does nothing, since a retry cannot know the command was not run; only the test suites wait 50 ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `SSH_TEARDOWN_MS` in `src/query/integration.test.ts` and `src/query/testing/live.ts`                             | the live suites themselves, which fail without the wait                                                                                                                                                   | a TS3 release no longer shows it                                  |
| TS6 6.0.0-beta13.1, SSH            | `ftstop` for a transfer that is not the query connection's own (one that does not exist, or another client's) crashes the server. Nothing is done in code; the `stopFileTransfer` doc comment says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                                                                             | none: a test would crash the server. `src/query/files.integration.test.ts` stops only the transfer's owner.                                                                                               | a TS6 release no longer crashes                                   |
| TS6 6.0.0-beta13.1, WebQuery       | Measured over WebQuery when a Server Admin voice client is connected: `channelcreate` and the four group creates and copies are answered with status ok and no `body`, in 2 to 75% of the creates of a run, since the server writes the id after its status and the HTTP answer has none. On a quiet server, or with only a plain voice client, the id came back every time. The SDK looks the object up by its unique key, group name and type, or channel name under its parent. That is exact, since the server refuses a duplicate (1282 for a group, 771 for a channel); the one gap is another client renaming or deleting the object between the create and the lookup. It runs only when the id is missing, so it never runs on a correct server. | `recoveredGroupID` in `src/core/api/command.ts`, and the lookup in `createChannel` in `src/core/api/channels.ts` | `src/core/api/command.test.ts` and `src/core/api/group-recovery.test.ts`; live `src/query/integration.test.ts` (creates whose answer carries no data) and `src/client/voice-features.integration.test.ts` | a TS6 release, re-measured under these conditions, returns the id |

## Breaking changes the core needs before 1.0

None remain. The probe measured one gap: `channelinfo` carries
`Channel.totalClients`, `Channel.totalFamilyClients` and
`Channel.neededSubscribePower` on neither server, so `getChannelInfo` reported
0 for each while `listChannels` reported the real count. That was fixed by
making the three fields `number | undefined`, which `getChannelInfo` leaves
undefined.

Everything else the probe found is class a, b or c, or is a limit of a server
and not of the core: a query client cannot be poked or kicked from the server,
cannot use a privilege key, and TS6 over WebQuery has no file transfers and no
events.
