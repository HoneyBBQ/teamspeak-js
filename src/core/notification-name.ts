/**
 * The names of the notifications a TeamSpeak server sends, for matching the
 * `notification` event:
 *
 * ```ts
 * client.on(EventName.Notification, (n) => {
 *   if (n.name === NotificationName.ChannelEdited) { ... }
 * });
 * ```
 *
 * Many are also how the voice protocol answers a command, which the client
 * already pairs with its command. A server may send notifications this table
 * does not name, which is why `NotificationEvent.name` is not limited to it.
 */
const notificationNameValues = {
  /** `notifyapikeyadd`: Reply to apikeyadd: the new API key, with its id, scope and lifetime. */
  APIKeyAdd: "notifyapikeyadd",
  /** `notifyapikeylist`: Reply to apikeylist: one row per API key. */
  APIKeyList: "notifyapikeylist",
  /** `notifybanfind`: Reply to banfind: one row per ban rule that matches. */
  BanFind: "notifybanfind",
  /** `notifybanlist`: Reply to banlist: one row per ban rule on the virtual server. */
  BanList: "notifybanlist",
  /** `notifybanupdate`: A ban changed; sent to a ServerQuery connection registered for `bans`. An addition carries the ban row, a deletion its `banid`, a delete-all neither (TS6 6.0.0-beta13.1, `op` says which). */
  BanUpdate: "notifybanupdate",
  /** `notifychannelchanged`: A channel's properties changed and this client should fetch them again. */
  ChannelChanged: "notifychannelchanged",
  /** `notifychannelclientpermlist`: Reply to channelclientpermlist: one row per permission set for a client in a channel. */
  ChannelClientPermList: "notifychannelclientpermlist",
  /** `notifychannelcreated`: A channel was created: it carries the new channel's properties and who created it. */
  ChannelCreated: "notifychannelcreated",
  /** `notifychanneldeleted`: A channel was deleted, with who deleted it. */
  ChannelDeleted: "notifychanneldeleted",
  /** `notifychanneldescriptionchanged`: A channel's description changed; the new text is fetched with channelgetdescription. */
  ChannelDescriptionChanged: "notifychanneldescriptionchanged",
  /** `notifychanneledited`: A channel was edited and these are its changed properties; it is also the reply to channelgetdescription, carrying the description. */
  ChannelEdited: "notifychanneledited",
  /** `notifychannelgroupclientlist`: Reply to channelgroupclientlist: one row per client assigned to a channel group in a channel. */
  ChannelGroupClientList: "notifychannelgroupclientlist",
  /** `notifychannelgrouplist`: Reply to channelgrouplist, and sent by the server on joining: one row per channel group. */
  ChannelGroupList: "notifychannelgrouplist",
  /** `notifychannelgrouppermlist`: Reply to channelgrouppermlist: one row per permission set on a channel group. */
  ChannelGroupPermList: "notifychannelgrouppermlist",
  /** `notifychannelmoved`: A channel was moved under another parent channel or reordered, with who moved it. */
  ChannelMoved: "notifychannelmoved",
  /** `notifychannelpasswordchanged`: A channel's password was set or changed. */
  ChannelPasswordChanged: "notifychannelpasswordchanged",
  /** `notifychannelpermhints`: The permissions this client holds on a channel changed; a bit set of hints tells which kinds of permission changed. */
  ChannelPermHints: "notifychannelpermhints",
  /** `notifychannelpermlist`: Reply to channelpermlist: one row per permission set on a channel. */
  ChannelPermList: "notifychannelpermlist",
  /** `notifychannelsubscribed`: This client is now subscribed to a channel, so it will see the clients in it. */
  ChannelSubscribed: "notifychannelsubscribed",
  /** `notifychannelunsubscribed`: This client is no longer subscribed to a channel, so the clients in it have gone out of view. */
  ChannelUnsubscribed: "notifychannelunsubscribed",
  /** `notifyclientchannelgroupchanged`: A client's channel group in a channel changed, with who changed it. */
  ClientChannelGroupChanged: "notifyclientchannelgroupchanged",
  /** `notifyclientchatclosed`: A client closed its private chat with this client. */
  ClientChatClosed: "notifyclientchatclosed",
  /** `notifyclientchatcomposing`: A client is typing a private message to this client. */
  ClientChatComposing: "notifyclientchatcomposing",
  /** `notifyclientdbfind`: Reply to clientdbfind: one row per matching client in the database. */
  ClientDBFind: "notifyclientdbfind",
  /** `notifyclientdbidfromuid`: Reply to clientgetdbidfromuid: the database id of the client with that unique id. */
  ClientDBIDFromUID: "notifyclientdbidfromuid",
  /** `notifyclientdblist`: Reply to clientdblist: one row per client known to the server. */
  ClientDBList: "notifyclientdblist",
  /** `notifycliententerview`: A client came into view: it connected, or moved into a channel this client is subscribed to. */
  ClientEnterView: "notifycliententerview",
  /** `notifyclientids`: Reply to clientgetids: the online client ids that belong to a unique id. */
  ClientIDs: "notifyclientids",
  /** `notifyclientleftview`: A client went out of view: it disconnected, was kicked or banned, or moved out of the subscribed channels. */
  ClientLeftView: "notifyclientleftview",
  /** `notifyclientmoved`: A client moved to another channel, with the reason and who moved it. */
  ClientMoved: "notifyclientmoved",
  /** `notifyclientnamefromdbid`: Reply to clientgetnamefromdbid: the unique id and nickname of the client with that database id. */
  ClientNameFromDBID: "notifyclientnamefromdbid",
  /** `notifyclientnamefromuid`: Reply to clientgetnamefromuid: the database id and nickname of the client with that unique id. */
  ClientNameFromUID: "notifyclientnamefromuid",
  /** `notifyclientneededpermissions`: A command failed or a feature is unavailable because this client lacks a permission; it names the permission id and the value needed. */
  ClientNeededPermissions: "notifyclientneededpermissions",
  /** `notifyclientpermhints`: The permissions this client holds changed; a bit set of hints tells which kinds of permission changed. */
  ClientPermHints: "notifyclientpermhints",
  /** `notifyclientpermlist`: Reply to clientpermlist: one row per permission set on a client. */
  ClientPermList: "notifyclientpermlist",
  /** `notifyclientpoke`: Another client poked this client with a message. */
  ClientPoke: "notifyclientpoke",
  /** `notifyclientserverqueryloginpassword`: Reply to clientsetserverquerylogin: the generated ServerQuery password. */
  ClientServerQueryLoginPassword: "notifyclientserverqueryloginpassword",
  /** `notifyclientuidfromclid`: Reply to clientgetuidfromclid: the unique id and nickname of the client with that client id. */
  ClientUIDFromCLID: "notifyclientuidfromclid",
  /** `notifyclientupdated`: A client in view changed some of its properties, such as its nickname, mute state or away message. */
  ClientUpdated: "notifyclientupdated",
  /** `notifycomplainlist`: Reply to complainlist: one row per complaint. */
  ComplainList: "notifycomplainlist",
  /** `notifyconnectioninfo`: A client's connection statistics, sent in answer to a request for them (getconnectioninfo). */
  ConnectionInfo: "notifyconnectioninfo",
  /** `notifyconnectioninforequest`: The server asks this client to report its own connection statistics with setconnectioninfo. */
  ConnectionInfoRequest: "notifyconnectioninforequest",
  /** `notifyfileinfo`: Reply to ftgetfileinfo: one row per file, with its size and modification time. */
  FileInfo: "notifyfileinfo",
  /** `notifyfilelist`: Reply to ftgetfilelist: one row per file or directory in a channel's file repository. */
  FileList: "notifyfilelist",
  /** `notifyfilelistfinished`: The server has sent every notifyfilelist row for a channel path. */
  FileListFinished: "notifyfilelistfinished",
  /** `notifyfiletransferlist`: Reply to ftlist: one row per running file transfer. */
  FileTransferList: "notifyfiletransferlist",
  /** `notifymessage`: Reply to messageget: an offline message with its subject and body. */
  Message: "notifymessage",
  /** `notifymessagelist`: Reply to messagelist: one row per offline message in this client's inbox. */
  MessageList: "notifymessagelist",
  /** `notifypermfind`: Reply to permfind: one row per place a permission is assigned. */
  PermFind: "notifypermfind",
  /** `notifypermissionlist`: Reply to permissionlist: one row per permission the server knows, with its id, name and description. */
  PermissionList: "notifypermissionlist",
  /** `notifypermoverview`: Reply to permoverview: one row per permission assignment that applies to a client in a channel. */
  PermOverview: "notifypermoverview",
  /** `notifypermget`: Reply to permget on TeamSpeak 6: the permission asked for, with its id and value. */
  PermGet: "notifypermget",
  /** `notifyplugincmd`: A plugin command another client sent with plugincmd, to this client's channel or to it directly. */
  PluginCmd: "notifyplugincmd",
  /** `notifyserverconnectioninfo`: Reply to serverrequestconnectioninfo: the virtual server's traffic and bandwidth statistics. */
  ServerConnectionInfo: "notifyserverconnectioninfo",
  /** `notifyserveredited`: The virtual server's settings were edited, with who edited them and the settings that changed. */
  ServerEdited: "notifyserveredited",
  /** `notifyservergroupclientadded`: A client was added to a server group, with who added it. */
  ServerGroupClientAdded: "notifyservergroupclientadded",
  /** `notifyservergroupclientdeleted`: A client was removed from a server group, with who removed it. */
  ServerGroupClientDeleted: "notifyservergroupclientdeleted",
  /** `notifyservergroupclientlist`: Reply to servergroupclientlist: one row per client in a server group. */
  ServerGroupClientList: "notifyservergroupclientlist",
  /** `notifyservergrouplist`: Reply to servergrouplist, and sent by the server on joining: one row per server group. */
  ServerGroupList: "notifyservergrouplist",
  /** `notifyservergrouppermlist`: Reply to servergrouppermlist: one row per permission set on a server group. */
  ServerGroupPermList: "notifyservergrouppermlist",
  /** `notifyservergroupsbyclientid`: Reply to servergroupsbyclientid: one row per server group a client belongs to. */
  ServerGroupsByClientID: "notifyservergroupsbyclientid",
  /** `notifyserverlog`: Reply to logview: a chunk of the server log with the position to read on from. */
  ServerLog: "notifyserverlog",
  /** `notifyservertemppasswordlist`: Reply to servertemppasswordlist: one row per active temporary server password. */
  ServerTempPasswordList: "notifyservertemppasswordlist",
  /** `notifyserverupdated`: The virtual server's statistics and settings, sent when they change or when this client asks for them. */
  ServerUpdated: "notifyserverupdated",
  /** `notifystartdownload`: Reply to ftinitdownload: the key, port and size to start a download on the file transfer port. */
  StartDownload: "notifystartdownload",
  /** `notifystartupload`: Reply to ftinitupload: the key, port and offset to start an upload on the file transfer port. */
  StartUpload: "notifystartupload",
  /** `notifystatusfiletransfer`: A file transfer ended or failed: it carries the status code and message for the transfer's client-side id. */
  StatusFileTransfer: "notifystatusfiletransfer",
  /** `notifytextmessage`: A text message arrived, to this client, its channel or the whole server, with who sent it. */
  TextMessage: "notifytextmessage",
  /** `notifytokenadd`: Reply to privilegekeyadd: the new privilege key. */
  TokenAdd: "notifytokenadd",
  /** `notifytokenlist`: Reply to privilegekeylist: one row per privilege key. */
  TokenList: "notifytokenlist",
  /** `notifytokenused`: A privilege key was used, with who used it and the groups it granted. */
  TokenUsed: "notifytokenused",
} as const;

/** The notification names; see {@link NotificationName}'s entries for what each carries. */
export const NotificationName: typeof notificationNameValues =
  /* @__PURE__ */ Object.freeze(notificationNameValues);

/** A notification name a TeamSpeak 3.13 or 6 server sends. */
export type NotificationName = (typeof NotificationName)[keyof typeof NotificationName];
