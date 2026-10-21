/**
 * The names of the commands a TeamSpeak server takes, for a raw line sent with
 * `client.exec` (built with `escape`) and for reading `CommandRequest.command`
 * in command middleware:
 *
 * ```ts
 * await client.exec(`${CommandName.ServerGroupList}`);
 * // or, in command middleware:
 * if (request.command === CommandName.ClientMove) { ... }
 * ```
 *
 * A name marked TeamSpeak 6 only is missing on TeamSpeak 3, and one marked
 * voice protocol only is not a ServerQuery command. A server may know commands
 * this table does not.
 */
const commandNameValues = {
  /** `apikeyadd`: Creates a new api key with the given scope for the invoking user. */
  APIKeyAdd: "apikeyadd",
  /** `apikeydel`: Deletes an apikey. */
  APIKeyDel: "apikeydel",
  /** `apikeylist`: Lists the api keys of the invoking user, or of all users. */
  APIKeyList: "apikeylist",
  /** `authenticationtoken`: Returns a token other services can use as proof that this server identifies you as a user. TeamSpeak 6 only. */
  AuthenticationToken: "authenticationtoken",
  /** `banadd`: Adds a new ban rule on the selected virtual server. */
  BanAdd: "banadd",
  /** `banclient`: Bans one or more clients specified with the given client ids from the server. */
  BanClient: "banclient",
  /** `bandel`: Deletes the ban rule with ID banid from the server. */
  BanDel: "bandel",
  /** `bandelall`: Deletes all active ban rules from the server. */
  BanDelAll: "bandelall",
  /** `banfind`: Displays a list of matching bans on the selected virtual server. TeamSpeak 6 only. */
  BanFind: "banfind",
  /** `banlist`: Displays a list of active bans on the selected virtual server. */
  BanList: "banlist",
  /** `bindinglist`: Displays a list of IP addresses used by the server instance on multi-homed machines. */
  BindingList: "bindinglist",
  /** `channeladdperm`: Adds a set of specified permissions to a channel. */
  ChannelAddPerm: "channeladdperm",
  /** `channelclientaddperm`: Adds a set of specified permissions to a client in a specific channel. */
  ChannelClientAddPerm: "channelclientaddperm",
  /** `channelclientdelperm`: Removes a set of specified permissions from a client in a specific channel. */
  ChannelClientDelPerm: "channelclientdelperm",
  /** `channelclientpermlist`: Displays a list of permissions defined for a client in a specific channel. */
  ChannelClientPermList: "channelclientpermlist",
  /** `channelcreate`: Creates a new channel using the given properties and displays its ID. */
  ChannelCreate: "channelcreate",
  /** `channeldelete`: Deletes an existing channel by ID. */
  ChannelDelete: "channeldelete",
  /** `channeldelperm`: Removes a set of specified permissions from a channel. */
  ChannelDelPerm: "channeldelperm",
  /** `channeledit`: Changes a channel's configuration using given properties. */
  ChannelEdit: "channeledit",
  /** `channelfind`: Displays a list of channels matching a given name pattern. */
  ChannelFind: "channelfind",
  /** `channelgetdescription`: Asks the server for a channel's description, which it is not sent with the channel list. Voice protocol only. */
  ChannelGetDescription: "channelgetdescription",
  /** `channelgroupadd`: Creates a new channel group using a given name and displays its ID. */
  ChannelGroupAdd: "channelgroupadd",
  /** `channelgroupaddperm`: Adds a set of specified permissions to a channel group. */
  ChannelGroupAddPerm: "channelgroupaddperm",
  /** `channelgroupclientlist`: Displays all the client and/or channel IDs currently assigned to channel groups. */
  ChannelGroupClientList: "channelgroupclientlist",
  /** `channelgroupcopy`: Creates a copy of a channel group, or overwrites an existing group with it. */
  ChannelGroupCopy: "channelgroupcopy",
  /** `channelgroupdel`: Deletes a channel group by ID. */
  ChannelGroupDel: "channelgroupdel",
  /** `channelgroupdelperm`: Removes a set of specified permissions from the channel group. */
  ChannelGroupDelPerm: "channelgroupdelperm",
  /** `channelgrouplist`: Displays a list of channel groups available on the selected virtual server. */
  ChannelGroupList: "channelgrouplist",
  /** `channelgrouppermlist`: Displays a list of permissions assigned to the channel group specified with cgid. */
  ChannelGroupPermList: "channelgrouppermlist",
  /** `channelgrouprename`: Changes the name of a specified channel group. */
  ChannelGroupRename: "channelgrouprename",
  /** `channelinfo`: Displays detailed configuration information about a channel including ID, topic, description, etc. */
  ChannelInfo: "channelinfo",
  /** `channellist`: Displays a list of channels created on a virtual server including their ID, order, name, etc. */
  ChannelList: "channellist",
  /** `channelmove`: Moves a channel to a new parent channel with the ID cpid. */
  ChannelMove: "channelmove",
  /** `channelpermlist`: Displays a list of permissions defined for a channel. */
  ChannelPermList: "channelpermlist",
  /** `channelsubscribe`: Subscribes this client to a channel so it sees the clients in it and their voice. Voice protocol only. */
  ChannelSubscribe: "channelsubscribe",
  /** `channelsubscribeall`: Subscribes this client to every channel on the server. Voice protocol only. */
  ChannelSubscribeAll: "channelsubscribeall",
  /** `channelunsubscribe`: Unsubscribes this client from a channel, so the clients in it go out of view. Voice protocol only. */
  ChannelUnsubscribe: "channelunsubscribe",
  /** `channelunsubscribeall`: Unsubscribes this client from every channel. Voice protocol only. */
  ChannelUnsubscribeAll: "channelunsubscribeall",
  /** `chatlogintoken`: Returns a JSON Web Token for logging in to the Matrix server the server uses for chat. TeamSpeak 6 only. */
  ChatLoginToken: "chatlogintoken",
  /** `clientaddperm`: Adds a set of specified permissions to a client. */
  ClientAddPerm: "clientaddperm",
  /** `clientaddservergroup`: Adds a client to one or more server groups specified with sgid. */
  ClientAddServerGroup: "clientaddservergroup",
  /** `clientdbdelete`: Deletes a client's properties from the database. */
  ClientDBDelete: "clientdbdelete",
  /** `clientdbedit`: Changes a client's settings using given properties. */
  ClientDBEdit: "clientdbedit",
  /** `clientdbfind`: Displays a list of client database IDs matching a given pattern. */
  ClientDBFind: "clientdbfind",
  /** `clientdbinfo`: Displays detailed database information about a client including unique ID, creation date, etc. */
  ClientDBInfo: "clientdbinfo",
  /** `clientdblist`: Displays a list of client identities known by the server including their database ID, last nickname, etc. */
  ClientDBList: "clientdblist",
  /** `clientdelperm`: Removes a set of specified permissions from a client. */
  ClientDelPerm: "clientdelperm",
  /** `clientdelservergroup`: Removes a client from one or more server groups. */
  ClientDelServerGroup: "clientdelservergroup",
  /** `clientdisconnect`: Tells the server this client is leaving, with an optional reason message. Voice protocol only. */
  ClientDisconnect: "clientdisconnect",
  /** `clientedit`: Changes a client's settings using given properties. */
  ClientEdit: "clientedit",
  /** `clientfind`: Displays a list of clients matching a given name pattern. */
  ClientFind: "clientfind",
  /** `clientgetdbidfromuid`: Displays the database ID matching the unique identifier specified by cluid. */
  ClientGetDBIDFromUID: "clientgetdbidfromuid",
  /** `clientgetids`: Displays all client IDs matching the unique identifier specified by cluid. */
  ClientGetIDs: "clientgetids",
  /** `clientgetnamefromdbid`: Displays the unique identifier and nickname matching the database ID specified by cldbid. */
  ClientGetNameFromDBID: "clientgetnamefromdbid",
  /** `clientgetnamefromuid`: Displays the database ID and nickname matching the unique identifier specified by cluid. */
  ClientGetNameFromUID: "clientgetnamefromuid",
  /** `clientgetuidfromclid`: Displays the unique identifier matching the clientID specified by clid. */
  ClientGetUIDFromCLID: "clientgetuidfromclid",
  /** `clientgetvariables`: Asks the server to send a client's properties again, as a `notifyclientupdated`. Voice protocol only. */
  ClientGetVariables: "clientgetvariables",
  /** `clientinfo`: Displays detailed configuration information about a client including unique ID, nickname, client version, etc. */
  ClientInfo: "clientinfo",
  /** `clientkick`: Kicks one or more clients from their channel (reasonid 4) or from the server (reasonid 5). */
  ClientKick: "clientkick",
  /** `clientlist`: Displays a list of clients online on a virtual server including their ID, nickname, status flags, etc. */
  ClientList: "clientlist",
  /** `clientmove`: Moves one or more clients to another channel. */
  ClientMove: "clientmove",
  /** `clientmute`: Stops the server forwarding the given clients' voice to this client. Voice protocol only. */
  ClientMute: "clientmute",
  /** `clientpermlist`: Displays a list of permissions defined for a client. */
  ClientPermList: "clientpermlist",
  /** `clientpoke`: Sends a poke message to the client specified with clid. */
  ClientPoke: "clientpoke",
  /** `clientsetserverquerylogin`: Updates your own ServerQuery login credentials using a specified username. */
  ClientSetServerQueryLogin: "clientsetserverquerylogin",
  /** `clientunmute`: Resumes forwarding the given clients' voice to this client. Voice protocol only. */
  ClientUnmute: "clientunmute",
  /** `clientupdate`: Changes your ServerQuery clients settings using given properties. */
  ClientUpdate: "clientupdate",
  /** `complainadd`: Submits a complaint about a connected client with database ID tcldbid to the server. */
  ComplainAdd: "complainadd",
  /** `complaindel`: Deletes the complaint about the client with ID tcldbid submitted by the client with ID fcldbid from the server. */
  ComplainDel: "complaindel",
  /** `complaindelall`: Deletes all complaints about the client with database ID tcldbid from the server. */
  ComplainDelAll: "complaindelall",
  /** `complainlist`: Displays a list of complaints on the selected virtual server. */
  ComplainList: "complainlist",
  /** `customdelete`: Removes a custom property from a client specified by the cldbid. */
  CustomDelete: "customdelete",
  /** `custominfo`: Displays a list of custom properties for the client specified with cldbid. */
  CustomInfo: "custominfo",
  /** `customsearch`: Searches for custom client properties specified by ident and value. */
  CustomSearch: "customsearch",
  /** `customset`: Creates or updates a custom property for client specified by the cldbid. */
  CustomSet: "customset",
  /** `getconnectioninfo`: Asks the server for a client's connection statistics, answered by `notifyconnectioninfo`. Voice protocol only. */
  GetConnectionInfo: "getconnectioninfo",
  /** `ftcreatedir`: Creates new directory in a channel's file repository. */
  FTCreateDir: "ftcreatedir",
  /** `ftdeletefile`: Deletes one or more files stored in a channel's file repository. */
  FTDeleteFile: "ftdeletefile",
  /** `ftgetchannelfilehttptoken`: Returns a JSON Web Token for authenticating to a HTTP file transfer server. TeamSpeak 6 only. */
  FTGetChannelFileHTTPToken: "ftgetchannelfilehttptoken",
  /** `ftgetfileinfo`: Displays detailed information about one or more specified files stored in a channel's file repository. */
  FTGetFileInfo: "ftgetfileinfo",
  /** `ftgetfilelist`: Displays a list of files and directories stored in the specified channels file repository. */
  FTGetFileList: "ftgetfilelist",
  /** `ftinitdownload`: Initializes a file transfer download. */
  FTInitDownload: "ftinitdownload",
  /** `ftinitupload`: Initializes a file transfer upload. */
  FTInitUpload: "ftinitupload",
  /** `ftlist`: Displays a list of running file transfers on the selected virtual server. */
  FTList: "ftlist",
  /** `ftrenamefile`: Renames a file in a channel's file repository. */
  FTRenameFile: "ftrenamefile",
  /** `ftstop`: Stops the running file transfer with server-side ID serverftfid. */
  FTStop: "ftstop",
  /** `gm`: Sends a text message to all clients on all virtual servers in the server instance. */
  GM: "gm",
  /** `help`: Lists all commands, or shows the usage, permissions and parameters of one command. */
  Help: "help",
  /** `homebasedel`: Unsets this server as the matrix homebase server for the calling client, or the client specified with cldbid if given. TeamSpeak 6 only. */
  HomeBaseDel: "homebasedel",
  /** `homebaseisset`: Checks if this server is set as the matrix homebase server for the calling client, or the client specified with cldbid if given. TeamSpeak 6 only. */
  HomeBaseIsSet: "homebaseisset",
  /** `homebaselist`: Lists all users that have set this server as their matrix homebase. TeamSpeak 6 only. */
  HomeBaseList: "homebaselist",
  /** `homebaseset`: Sets this server as the matrix homebase server for the calling client, or the client specified with cldbid if given. TeamSpeak 6 only. */
  HomeBaseSet: "homebaseset",
  /** `hostinfo`: Displays detailed connection information about the server instance including uptime, number of virtual servers online, traffic information, etc. */
  HostInfo: "hostinfo",
  /** `instanceedit`: Changes the server instance configuration using given properties. */
  InstanceEdit: "instanceedit",
  /** `instanceinfo`: Displays the server instance configuration including database revision number, the file transfer port, default group IDs, etc. */
  InstanceInfo: "instanceinfo",
  /** `joinstreamrequest`: Asks the owner of a stream to let this client watch it, or, with `is_remove=1`, says it stops watching. Voice protocol only, TeamSpeak 6 only; undocumented by TeamSpeak. */
  JoinStreamRequest: "joinstreamrequest",
  /** `licensesignmessage`: Signs the message with the private key of your license. TeamSpeak 6 only. */
  LicenseSignMessage: "licensesignmessage",
  /** `logadd`: Writes a custom entry into the server's log. */
  LogAdd: "logadd",
  /** `login`: Authenticates with the server instance using given ServerQuery login credentials. */
  Login: "login",
  /** `logout`: Deselects the active virtual server and logs out from the server instance. */
  Logout: "logout",
  /** `logview`: Displays a specified number of entries from the server's log. */
  LogView: "logview",
  /** `messageadd`: Sends an offline message to the client specified by cluid. */
  MessageAdd: "messageadd",
  /** `messagedel`: Deletes an existing offline message with ID msgid from your inbox. */
  MessageDel: "messagedel",
  /** `messageget`: Displays an existing offline message with ID msgid from your inbox. */
  MessageGet: "messageget",
  /** `messagelist`: Displays a list of offline messages you've received. */
  MessageList: "messagelist",
  /** `messageupdateflag`: Updates the flag_read property of the offline message specified with msgid. */
  MessageUpdateFlag: "messageupdateflag",
  /** `permfind`: Displays detailed information about all assignments of the permission specified with permid. */
  PermFind: "permfind",
  /** `permget`: Displays the current value of the permission specified with permid or permsid for your own connection. */
  PermGet: "permget",
  /** `permidgetbyname`: Displays the database ID of one or more permissions specified by permsid. */
  PermIDGetByName: "permidgetbyname",
  /** `permissionlist`: Displays a list of permissions available on the server instance including ID, name and description. */
  PermissionList: "permissionlist",
  /** `permoverview`: Displays all permissions assigned to a client for the channel specified with cid. */
  PermOverview: "permoverview",
  /** `permreset`: Restores the default permission settings on the selected virtual server and creates a new initial administrator token. */
  PermReset: "permreset",
  /** `privilegekeyadd`: Creates a new privilege key, a token that grants a server or channel group. */
  PrivilegeKeyAdd: "privilegekeyadd",
  /** `privilegekeydelete`: Deletes an existing token matching the token key specified with token. */
  PrivilegeKeyDelete: "privilegekeydelete",
  /** `privilegekeylist`: Displays a list of privilege keys available including their type and group IDs. */
  PrivilegeKeyList: "privilegekeylist",
  /** `privilegekeyuse`: Uses a privilege key to gain access to a server or channel group. */
  PrivilegeKeyUse: "privilegekeyuse",
  /** `queryloginadd`: Adds a new query client login, or enables query login for existing clients. */
  QueryLoginAdd: "queryloginadd",
  /** `querylogindel`: Deletes an existing server query login on selected server. */
  QueryLoginDel: "querylogindel",
  /** `queryloginlist`: Lists existing query client logins. */
  QueryLoginList: "queryloginlist",
  /** `quit`: Closes the ServerQuery connection to the server instance. */
  Quit: "quit",
  /** `requeststreaminfo`: Asks for the streams a client has running, each answered with a `notifystreaminfo`. Voice protocol only, TeamSpeak 6 only; undocumented by TeamSpeak. */
  RequestStreamInfo: "requeststreaminfo",
  /** `respondjoinstreamrequest`: The stream owner's answer to a join request: accepts with the SDP offer, or denies. Voice protocol only, TeamSpeak 6 only; undocumented by TeamSpeak. */
  RespondJoinStreamRequest: "respondjoinstreamrequest",
  /** `sendtextmessage`: Sends a text message to a specified target. */
  SendTextMessage: "sendtextmessage",
  /** `servercreate`: Creates a new virtual server using the given properties and displays its ID, port and initial administrator privilege key. */
  ServerCreate: "servercreate",
  /** `serverdelete`: Deletes the virtual server specified with sid. */
  ServerDelete: "serverdelete",
  /** `serveredit`: Changes the selected virtual server's configuration using given properties. */
  ServerEdit: "serveredit",
  /** `servergroupadd`: Creates a new server group using the name specified with name and displays its ID. */
  ServerGroupAdd: "servergroupadd",
  /** `servergroupaddclient`: Adds one or more clients to the server group specified with sgid. */
  ServerGroupAddClient: "servergroupaddclient",
  /** `servergroupaddperm`: Adds a set of specified permissions to the server group specified with sgid. */
  ServerGroupAddPerm: "servergroupaddperm",
  /** `servergroupautoaddperm`: Adds a set of specified permissions to all regular server groups on all virtual servers. */
  ServerGroupAutoAddPerm: "servergroupautoaddperm",
  /** `servergroupautodelperm`: Removes a set of specified permissions from all regular server groups on all virtual servers. */
  ServerGroupAutoDelPerm: "servergroupautodelperm",
  /** `servergroupclientlist`: Displays the IDs of all clients currently residing in the server group specified with sgid. */
  ServerGroupClientList: "servergroupclientlist",
  /** `servergroupcopy`: Creates a copy of a server group, or overwrites an existing group with it. */
  ServerGroupCopy: "servergroupcopy",
  /** `servergroupdel`: Deletes the server group specified with sgid. */
  ServerGroupDel: "servergroupdel",
  /** `servergroupdelclient`: Removes one or more clients specified with cldbid from the server group specified with sgid. */
  ServerGroupDelClient: "servergroupdelclient",
  /** `servergroupdelperm`: Removes a set of specified permissions from the server group specified with sgid. */
  ServerGroupDelPerm: "servergroupdelperm",
  /** `servergrouplist`: Displays a list of server groups available. */
  ServerGroupList: "servergrouplist",
  /** `servergrouppermlist`: Displays a list of permissions assigned to the server group specified with sgid. */
  ServerGroupPermList: "servergrouppermlist",
  /** `servergrouprename`: Changes the name of the server group specified with sgid. */
  ServerGroupRename: "servergrouprename",
  /** `servergroupsbyclientid`: Displays all server groups the client specified with cldbid is currently residing in. */
  ServerGroupsByClientID: "servergroupsbyclientid",
  /** `serveridgetbyport`: Displays the database ID of the virtual server running on the UDP port specified by virtualserver_port. */
  ServerIDGetByPort: "serveridgetbyport",
  /** `servergetvariables`: Asks the server to send the virtual server's properties again, as a `notifyserverupdated`. Voice protocol only. */
  ServerGetVariables: "servergetvariables",
  /** `serverinfo`: Displays detailed configuration information about the selected virtual server including unique ID, number of clients online, configuration, etc. */
  ServerInfo: "serverinfo",
  /** `serverlist`: Displays a list of virtual servers including their ID, status, number of clients online, etc. */
  ServerList: "serverlist",
  /** `servernotifyregister`: Registers for a specified category of events on a virtual server to receive notification messages. */
  ServerNotifyRegister: "servernotifyregister",
  /** `servernotifyunregister`: Unregisters from one category of events, or from all of them when no event is given. */
  ServerNotifyUnregister: "servernotifyunregister",
  /** `serverprocessstop`: Stops the entire server instance by shutting down the process. */
  ServerProcessStop: "serverprocessstop",
  /** `serverrequestconnectioninfo`: Displays detailed connection information about the selected virtual server including uptime, traffic information, etc. */
  ServerRequestConnectionInfo: "serverrequestconnectioninfo",
  /** `serversnapshotcreate`: Displays a snapshot of the selected virtual server containing all settings, groups and known client identities. */
  ServerSnapshotCreate: "serversnapshotcreate",
  /** `serversnapshotdeploy`: Restores the selected virtual server's configuration using the data from a previously created server snapshot. */
  ServerSnapshotDeploy: "serversnapshotdeploy",
  /** `serverstart`: Starts the virtual server specified with sid. */
  ServerStart: "serverstart",
  /** `serverstop`: Stops the virtual server specified with sid. */
  ServerStop: "serverstop",
  /** `servertemppasswordadd`: Sets a new temporary server password specified with pw. */
  ServerTempPasswordAdd: "servertemppasswordadd",
  /** `servertemppassworddel`: Deletes the temporary server password specified with pw. */
  ServerTempPasswordDel: "servertemppassworddel",
  /** `servertemppasswordlist`: Returns a list of active temporary server passwords. */
  ServerTempPasswordList: "servertemppasswordlist",
  /** `setclientchannelgroup`: Sets the channel group of a client to the ID specified with cgid. */
  SetClientChannelGroup: "setclientchannelgroup",
  /** `setupstream`: Starts a stream and announces it to the channel with a `notifystreamstarted`. Voice protocol only, TeamSpeak 6 only; undocumented by TeamSpeak. */
  SetupStream: "setupstream",
  /** `setconnectioninfo`: A client reporting its own connection statistics, in answer to notifyconnectioninforequest. Voice protocol only. */
  SetConnectionInfo: "setconnectioninfo",
  /** `stopstream`: Stops a stream. The server does not check who asks. Voice protocol only, TeamSpeak 6 only; undocumented by TeamSpeak. */
  StopStream: "stopstream",
  /** `streamsignaling`: Relays a signalling message, a JSON string, between the owner of a stream and a viewer it accepted. Voice protocol only, TeamSpeak 6 only; undocumented by TeamSpeak. */
  StreamSignaling: "streamsignaling",
  /** `tokenadd`: Alias for privilegekeyadd. */
  TokenAdd: "tokenadd",
  /** `tokendelete`: Alias for privilegekeydelete. */
  TokenDelete: "tokendelete",
  /** `tokenlist`: Alias for privilegekeylist. */
  TokenList: "tokenlist",
  /** `tokenuse`: Alias for privilegekeyuse. */
  TokenUse: "tokenuse",
  /** `use`: Selects the virtual server specified with sid or port to allow further interaction. */
  Use: "use",
  /** `version`: Displays the server's version information including platform and build number. */
  Version: "version",
  /** `verifychannelpassword`: Checks a channel's password, given hashed as the voice protocol sends it. Voice protocol only. */
  VerifyChannelPassword: "verifychannelpassword",
  /** `verifyserverpassword`: Checks the server's password, given hashed as the voice protocol sends it. Voice protocol only. */
  VerifyServerPassword: "verifyserverpassword",
  /** `whoami`: Displays information about your current ServerQuery connection including your loginname, etc. */
  WhoAmI: "whoami",
} as const;

/** The command names; see {@link CommandName}'s entries for what each does. */
export const CommandName: typeof commandNameValues =
  /* @__PURE__ */ Object.freeze(commandNameValues);

/** A command name a TeamSpeak 3.13 or 6 server knows. */
export type CommandName = (typeof CommandName)[keyof typeof CommandName];
