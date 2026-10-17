# Where the voice protocol puts a command's answer

Measured against TS3 3.13.8 and TS6 6.0.0-beta13.1 as Server Admin. The two
answer identically, command for command. Re-run the measurement with
`scripts/probe-response-shapes.mts`.

## Three shapes

ServerQuery answers a query with nameless data rows followed by `error`. The
voice protocol — the one a real TeamSpeak client speaks, and this SDK — uses
three shapes:

1. **Nameless rows**, as ServerQuery does: `channellist`, `clientinfo`,
   `serverinfo` and the like.
2. **A named notification before the `error`**: `servergrouplist` answers with
   `notifyservergrouplist`, `clientgetuidfromclid` with
   `notifyclientuidfromclid`. Most administrative lists work this way.
3. **A named notification after the `error`**: `ftinitupload` succeeds, and
   only then does `notifystartupload` arrive with the transfer key. It echoes
   the request's `clientftfid`, which is the only link between the two. A
   refusal arrives the same way, as `notifystatusfiletransfer` with a non-zero
   `status`.

Notifications carry no `return_code`, so nothing on the wire says which
command one answers. That pairing is a property of the command, recorded in
`src/core/command/responses.ts`; the client consults it for every command it sends,
including raw ones passed to `execCommandWithResponse`.

The same notification can also arrive unprompted — `notifyservergrouplist`
after someone else edits a group, `notifychannelcreated` for every channel
anyone creates — so it is still dispatched as an event, and `channelcreate`
keeps only the row whose `invokerid` is this client.

### A correction

An earlier version of this document said the voice protocol answers these
commands with `ok` and no data, and the SDK returned empty lists to match. The
data was there. The client routed every `notify*` line to its event handlers,
so the rows never reached the command waiting for them, and a raw dump of
nameless rows showed exactly what that bug predicted. `createServerGroup`
returned the first group on the server rather than the new one for a related
reason: the answer is the whole group list.

## Instance-level commands

`hostinfo`, `instanceinfo`, `bindinglist`, `serveridgetbyport` and
`permidgetbyname` answer error 2568 even for Server Admin. They need
`b_serverinstance_*` permissions, which no virtual-server group holds by
default and which only a ServerQuery admin can grant. Once granted they work
over the voice protocol with nameless rows.

`messageadd`, `customset`, `customdelete`, `apikeydel` and `queryloginadd` answer with
nothing; `custominfo`, `customsearch` and `banfind` (TS6) answer with nameless rows.
`queryloginadd`, `querylogindel`, `queryloginlist`, `login`, `logout` and `use` are
ServerQuery-only: a voice connection gets error 2 (not implemented) for them.

The instance-level commands `serverlist`, `servercreate`, `serverdelete`,
`serverstart`, `serversnapshotcreate`, `serversnapshotdeploy`, `gm`,
`servergroupautoaddperm` and `servergroupautodelperm` answer 2568 for a voice
client in the Server Admin group, as `hostinfo` does. `serverprocessstop` is
not sent over a voice connection.

## Commands that return nothing here

`banadd`, `banclient` and `servertemppasswordadd` succeed without reporting an
id over the voice protocol; ServerQuery reports one.

## Measured

| Command                       | Answer                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `apikeyadd`                   | `notifyapikeyadd`                                                                 |
| `apikeylist`                  | `notifyapikeylist`                                                                |
| `banadd`                      | nothing                                                                           |
| `banclient`                   | nothing (the banned client's `notifyclientleftview` is a side effect)             |
| `banlist`                     | `notifybanlist`                                                                   |
| `bindinglist`                 | nameless rows                                                                     |
| `channelclientpermlist`       | `notifychannelclientpermlist`                                                     |
| `channelcreate`               | `notifychannelcreated`, own row only (the creator is also moved into the channel) |
| `channelfind`                 | nameless rows                                                                     |
| `channelgetdescription`       | `notifychanneledited`                                                             |
| `channelgroupadd`             | `notifychannelgrouplist`                                                          |
| `channelgroupclientlist`      | `notifychannelgroupclientlist`                                                    |
| `channelgroupcopy`            | `notifychannelgrouplist`                                                          |
| `channelgrouplist`            | `notifychannelgrouplist`                                                          |
| `channelgrouppermlist`        | `notifychannelgrouppermlist`                                                      |
| `channelinfo`                 | nameless rows                                                                     |
| `channellist`                 | nameless rows                                                                     |
| `channelpermlist`             | `notifychannelpermlist`                                                           |
| `clientdbfind`                | `notifyclientdbfind`                                                              |
| `clientdbinfo`                | nameless rows                                                                     |
| `clientdblist`                | `notifyclientdblist`                                                              |
| `clientfind`                  | nameless rows                                                                     |
| `clientgetdbidfromuid`        | `notifyclientdbidfromuid`                                                         |
| `clientgetids`                | `notifyclientids`                                                                 |
| `clientgetnamefromdbid`       | `notifyclientnamefromdbid`                                                        |
| `clientgetnamefromuid`        | `notifyclientnamefromuid`                                                         |
| `clientgetuidfromclid`        | `notifyclientuidfromclid`                                                         |
| `clientgetvariables`          | `notifyclientupdated`                                                             |
| `clientinfo`                  | nameless rows                                                                     |
| `clientlist`                  | nameless rows                                                                     |
| `clientpermlist`              | `notifyclientpermlist`                                                            |
| `clientsetserverquerylogin`   | `notifyclientserverqueryloginpassword`                                            |
| `complainlist`                | `notifycomplainlist`                                                              |
| `ftgetfileinfo`               | `notifyfileinfo`                                                                  |
| `ftgetfilelist`               | `notifyfilelist`, `notifyfilelistfinished`                                        |
| `ftinitdownload`              | after `error`: `notifystartdownload` (by `clientftfid`)                           |
| `ftinitupload`                | after `error`: `notifystartupload` (by `clientftfid`)                             |
| `ftlist`                      | `notifyfiletransferlist`                                                          |
| `getconnectioninfo`           | `notifyconnectioninfo`                                                            |
| `hostinfo`                    | nameless rows                                                                     |
| `instanceinfo`                | nameless rows                                                                     |
| `logview`                     | `notifyserverlog`                                                                 |
| `messageget`                  | `notifymessage`                                                                   |
| `messagelist`                 | `notifymessagelist`                                                               |
| `permfind`                    | `notifypermfind`                                                                  |
| `permget`                     | `notifypermget` on TS6, nameless rows on TS3                                      |
| `permidgetbyname`             | nameless rows                                                                     |
| `permissionlist`              | `notifypermissionlist`                                                            |
| `permoverview`                | `notifypermoverview`                                                              |
| `privilegekeyadd`             | `notifytokenadd`                                                                  |
| `privilegekeylist`            | `notifytokenlist`                                                                 |
| `servergetvariables`          | `notifyserverupdated`                                                             |
| `servergroupadd`              | `notifyservergrouplist`                                                           |
| `servergroupclientlist`       | `notifyservergroupclientlist`                                                     |
| `servergroupcopy`             | `notifyservergrouplist`                                                           |
| `servergrouplist`             | `notifyservergrouplist`                                                           |
| `servergrouppermlist`         | `notifyservergrouppermlist`                                                       |
| `servergroupsbyclientid`      | `notifyservergroupsbyclientid`                                                    |
| `serveridgetbyport`           | nameless rows                                                                     |
| `serverinfo`                  | nameless rows                                                                     |
| `serverrequestconnectioninfo` | `notifyserverconnectioninfo`                                                      |
| `servertemppasswordadd`       | nothing                                                                           |
| `servertemppasswordlist`      | `notifyservertemppasswordlist`                                                    |
| `tokenadd`                    | `notifytokenadd`                                                                  |
| `tokenlist`                   | `notifytokenlist`                                                                 |
| `version`                     | nameless rows                                                                     |
| `whoami`                      | nameless rows                                                                     |
