/**
 * The properties a TeamSpeak server reports, by name: the keys of the records
 * `getServerInfo`, `getInstanceInfo`, `getHostInfo` and `getClientProperties` return,
 * and of the settings `editServer` and `editInstance` take:
 *
 * ```ts
 * const info = await getServerInfo(client);
 * console.log(info[PropertyName.VirtualServerName]);
 * ```
 *
 * They are grouped by the command that reports them, and a property that
 * several report is listed under the first. These are the names measured on
 * TeamSpeak 3.13 and 6; the ones marked TeamSpeak 3 only or TeamSpeak 6 only
 * are missing on the other. A server may send keys this table does not name.
 */
const propertyNameValues = {
  // Virtual server: serverinfo, and serveredit for those marked editable.
  /** `virtualserver_unique_identifier`: The server's unique id, a base64 string that stays the same when the server moves. */
  VirtualServerUniqueIdentifier: "virtualserver_unique_identifier",
  /** `virtualserver_name`: The name of the virtual server. Editable. */
  VirtualServerName: "virtualserver_name",
  /** `virtualserver_welcomemessage`: The welcome message of the server. Editable. */
  VirtualServerWelcomeMessage: "virtualserver_welcomemessage",
  /** `virtualserver_platform`: Operating system the server runs on, such as Linux. */
  VirtualServerPlatform: "virtualserver_platform",
  /** `virtualserver_version`: Server version and build, for example 3.13.8 [Build: 1779874471]. */
  VirtualServerVersion: "virtualserver_version",
  /** `virtualserver_maxclients`: The maximum number of clients to allow. Editable. */
  VirtualServerMaxClients: "virtualserver_maxclients",
  /** `virtualserver_password`: The password required to enter. Editable. */
  VirtualServerPassword: "virtualserver_password",
  /** `virtualserver_clientsonline`: Number of clients online, voice and ServerQuery clients together. */
  VirtualServerClientsOnline: "virtualserver_clientsonline",
  /** `virtualserver_channelsonline`: Number of channels on the server. */
  VirtualServerChannelsOnline: "virtualserver_channelsonline",
  /** `virtualserver_created`: When the virtual server was created, as a Unix timestamp in seconds. */
  VirtualServerCreated: "virtualserver_created",
  /** `virtualserver_uptime`: Seconds since the virtual server started. */
  VirtualServerUptime: "virtualserver_uptime",
  /** `virtualserver_codec_encryption_mode`: The global codec encryption mode of the virtual server; see `CodecEncryptionMode`. Editable. */
  VirtualServerCodecEncryptionMode: "virtualserver_codec_encryption_mode",
  /** `virtualserver_hostmessage`: The host message of the server. Editable. */
  VirtualServerHostMessage: "virtualserver_hostmessage",
  /** `virtualserver_hostmessage_mode`: The host message mode of the server (0 for None, 1 for message in chatlog, 2 for message as a modal, 3 for modal dialog and then quit). Editable. */
  VirtualServerHostMessageMode: "virtualserver_hostmessage_mode",
  /** `virtualserver_filebase`: Path of the server's file storage, relative to the server's working directory. */
  VirtualServerFileBase: "virtualserver_filebase",
  /** `virtualserver_default_server_group`: The default server group to use. Editable. */
  VirtualServerDefaultServerGroup: "virtualserver_default_server_group",
  /** `virtualserver_default_channel_group`: The default channel group to use. Editable. */
  VirtualServerDefaultChannelGroup: "virtualserver_default_channel_group",
  /** `virtualserver_flag_password`: 1 if the server has a password, 0 if it does not. */
  VirtualServerFlagPassword: "virtualserver_flag_password",
  /** `virtualserver_default_channel_admin_group`: The default channel administrator group to use. Editable. */
  VirtualServerDefaultChannelAdminGroup: "virtualserver_default_channel_admin_group",
  /** `virtualserver_max_download_total_bandwidth`: The max bandwidth for outgoing file transfers on the virtual server (Bytes/s). Editable. */
  VirtualServerMaxDownloadTotalBandwidth: "virtualserver_max_download_total_bandwidth",
  /** `virtualserver_max_upload_total_bandwidth`: The max bandwidth for incoming file transfers on the virtual server (Bytes/s). Editable. */
  VirtualServerMaxUploadTotalBandwidth: "virtualserver_max_upload_total_bandwidth",
  /** `virtualserver_hostbanner_url`: URL for the host banner. Editable. */
  VirtualServerHostBannerURL: "virtualserver_hostbanner_url",
  /** `virtualserver_hostbanner_gfx_url`: URL for the host banner image. Editable. */
  VirtualServerHostBannerGFXURL: "virtualserver_hostbanner_gfx_url",
  /** `virtualserver_hostbanner_gfx_interval`: Refresh time for the host banner image on the client side (in seconds). Editable. */
  VirtualServerHostBannerGFXInterval: "virtualserver_hostbanner_gfx_interval",
  /** `virtualserver_complain_autoban_count`: The number of complaints about a client we will tolerate before a ban. Editable. */
  VirtualServerComplainAutoBanCount: "virtualserver_complain_autoban_count",
  /** `virtualserver_complain_autoban_time`: The amount of time (in seconds) an autobanned client will be banned for. Editable. */
  VirtualServerComplainAutoBanTime: "virtualserver_complain_autoban_time",
  /** `virtualserver_complain_remove_time`: The amount of time (in seconds) before a complaint is deleted automatically. Editable. */
  VirtualServerComplainRemoveTime: "virtualserver_complain_remove_time",
  /** `virtualserver_min_clients_in_channel_before_forced_silence`: Number of clients in the same channel needed to force silence. Editable. */
  VirtualServerMinClientsInChannelBeforeForcedSilence:
    "virtualserver_min_clients_in_channel_before_forced_silence",
  /** `virtualserver_priority_speaker_dimm_modificator`: Client volume lowered automatically while a priority speaker is talking. Editable. */
  VirtualServerPrioritySpeakerDimmModificator: "virtualserver_priority_speaker_dimm_modificator",
  /** `virtualserver_id`: The virtual server's id, as used by use sid=. */
  VirtualServerID: "virtualserver_id",
  /** `virtualserver_antiflood_points_tick_reduce`: Anti-flood points removed from a client for being good. Editable. */
  VirtualServerAntiFloodPointsTickReduce: "virtualserver_antiflood_points_tick_reduce",
  /** `virtualserver_antiflood_points_needed_command_block`: Anti-flood points needed to block commands being executed by the client. Editable. */
  VirtualServerAntiFloodPointsNeededCommandBlock:
    "virtualserver_antiflood_points_needed_command_block",
  /** `virtualserver_antiflood_points_needed_ip_block`: Anti-flood points needed to block incoming connections from the client. Editable. */
  VirtualServerAntiFloodPointsNeededIPBlock: "virtualserver_antiflood_points_needed_ip_block",
  /** `virtualserver_client_connections`: Number of voice client connections made since the server started. */
  VirtualServerClientConnections: "virtualserver_client_connections",
  /** `virtualserver_query_client_connections`: Number of ServerQuery connections made since the server started. */
  VirtualServerQueryClientConnections: "virtualserver_query_client_connections",
  /** `virtualserver_hostbutton_tooltip`: Text used for the tooltip of the host button on client-side. Editable. */
  VirtualServerHostButtonTooltip: "virtualserver_hostbutton_tooltip",
  /** `virtualserver_hostbutton_url`: URL opened on click on the host button. Editable. */
  VirtualServerHostButtonURL: "virtualserver_hostbutton_url",
  /** `virtualserver_hostbutton_gfx_url`: URL for the host button on client-side. Editable. */
  VirtualServerHostButtonGFXURL: "virtualserver_hostbutton_gfx_url",
  /** `virtualserver_queryclientsonline`: Number of ServerQuery clients online. */
  VirtualServerQueryClientsOnline: "virtualserver_queryclientsonline",
  /** `virtualserver_download_quota`: Download quota for the virtual server (MByte). Editable. */
  VirtualServerDownloadQuota: "virtualserver_download_quota",
  /** `virtualserver_upload_quota`: Upload quota for the virtual server (MByte). Editable. */
  VirtualServerUploadQuota: "virtualserver_upload_quota",
  /** `virtualserver_month_bytes_downloaded`: Bytes of file transfer downloads this month. */
  VirtualServerMonthBytesDownloaded: "virtualserver_month_bytes_downloaded",
  /** `virtualserver_month_bytes_uploaded`: Bytes of file transfer uploads this month. */
  VirtualServerMonthBytesUploaded: "virtualserver_month_bytes_uploaded",
  /** `virtualserver_total_bytes_downloaded`: Bytes of file transfer downloads in total. */
  VirtualServerTotalBytesDownloaded: "virtualserver_total_bytes_downloaded",
  /** `virtualserver_total_bytes_uploaded`: Bytes of file transfer uploads in total. */
  VirtualServerTotalBytesUploaded: "virtualserver_total_bytes_uploaded",
  /** `virtualserver_port`: UDP port the virtual server is listening on. Editable. */
  VirtualServerPort: "virtualserver_port",
  /** `virtualserver_autostart`: 1 if started automatically with the instance, or 0 otherwise. Editable. */
  VirtualServerAutoStart: "virtualserver_autostart",
  /** `virtualserver_machine_id`: Machine id that tells servers on one machine apart when they share a database; empty if unset. */
  VirtualServerMachineID: "virtualserver_machine_id",
  /** `virtualserver_needed_identity_security_level`: Minimum client identity security level required to connect to the virtual server. Editable. */
  VirtualServerNeededIdentitySecurityLevel: "virtualserver_needed_identity_security_level",
  /** `virtualserver_log_client`: Indicates whether the server logs events related to clients or not. Editable. */
  VirtualServerLogClient: "virtualserver_log_client",
  /** `virtualserver_log_query`: Indicates whether the server logs events related to ServerQuery clients or not. Editable. */
  VirtualServerLogQuery: "virtualserver_log_query",
  /** `virtualserver_log_channel`: Indicates whether the server logs events related to channels or not. Editable. */
  VirtualServerLogChannel: "virtualserver_log_channel",
  /** `virtualserver_log_permissions`: Indicates whether the server logs events related to permissions or not. Editable. */
  VirtualServerLogPermissions: "virtualserver_log_permissions",
  /** `virtualserver_log_server`: Indicates whether the server logs events related to server changes or not. Editable. */
  VirtualServerLogServer: "virtualserver_log_server",
  /** `virtualserver_log_filetransfer`: Indicates whether the server logs events related to file transfers or not. Editable. */
  VirtualServerLogFileTransfer: "virtualserver_log_filetransfer",
  /** `virtualserver_min_client_version`: Minimal desktop client version required to connect (a build number). Editable. */
  VirtualServerMinClientVersion: "virtualserver_min_client_version",
  /** `virtualserver_name_phonetic`: Phonetic name of the virtual server. Editable. */
  VirtualServerNamePhonetic: "virtualserver_name_phonetic",
  /** `virtualserver_icon_id`: CRC32 checksum of the virtual server icon. Editable. */
  VirtualServerIconID: "virtualserver_icon_id",
  /** `virtualserver_reserved_slots`: Number of reserved slots available on the virtual server. Editable. */
  VirtualServerReservedSlots: "virtualserver_reserved_slots",
  /** `virtualserver_total_packetloss_speech`: Average packet loss of voice packets, as a fraction between 0 and 1. */
  VirtualServerTotalPacketLossSpeech: "virtualserver_total_packetloss_speech",
  /** `virtualserver_total_packetloss_keepalive`: Average packet loss of keepalive packets, as a fraction between 0 and 1. */
  VirtualServerTotalPacketLossKeepAlive: "virtualserver_total_packetloss_keepalive",
  /** `virtualserver_total_packetloss_control`: Average packet loss of control packets, as a fraction between 0 and 1. */
  VirtualServerTotalPacketLossControl: "virtualserver_total_packetloss_control",
  /** `virtualserver_total_packetloss_total`: Average packet loss over all packets, as a fraction between 0 and 1. */
  VirtualServerTotalPacketLossTotal: "virtualserver_total_packetloss_total",
  /** `virtualserver_total_ping`: Average ping of all clients, in milliseconds. */
  VirtualServerTotalPing: "virtualserver_total_ping",
  /** `virtualserver_ip`: IP addresses the virtual server listens on, separated by commas. */
  VirtualServerIP: "virtualserver_ip",
  /** `virtualserver_weblist_enabled`: Indicates whether the server appears in the global web server list or not. Editable. */
  VirtualServerWebListEnabled: "virtualserver_weblist_enabled",
  /** `virtualserver_ask_for_privilegekey`: 1 if clients are asked for a privilege key on their first connection to an unclaimed server, 0 if not. */
  VirtualServerAskForPrivilegeKey: "virtualserver_ask_for_privilegekey",
  /** `virtualserver_hostbanner_mode`: The display mode for the virtual servers hostbanner; see `BannerMode`. Editable. */
  VirtualServerHostBannerMode: "virtualserver_hostbanner_mode",
  /** `virtualserver_channel_temp_delete_delay_default`: Default delay, in seconds, before an empty temporary channel is deleted. */
  VirtualServerChannelTempDeleteDelayDefault: "virtualserver_channel_temp_delete_delay_default",
  /** `virtualserver_min_android_version`: Minimal Android client version required to connect. Editable. */
  VirtualServerMinAndroidVersion: "virtualserver_min_android_version",
  /** `virtualserver_min_ios_version`: Minimal iOS client version required to connect. Editable. */
  VirtualServerMinIOSVersion: "virtualserver_min_ios_version",
  /** `virtualserver_nickname`: Nickname the server uses when it speaks, for example in server messages; empty uses the default. */
  VirtualServerNickname: "virtualserver_nickname",
  /** `virtualserver_antiflood_points_needed_plugin_block`: Anti-flood points needed to block plugin commands from the client; if set to 0, the same as virtualserver_antiflood_points_needed_command_block is used. Editable. */
  VirtualServerAntiFloodPointsNeededPluginBlock:
    "virtualserver_antiflood_points_needed_plugin_block",
  /** `virtualserver_capability_extensions`: Optional protocol features the server supports, separated by commas. */
  VirtualServerCapabilityExtensions: "virtualserver_capability_extensions",
  /** `virtualserver_file_storage_class`: Storage backend of the server's files; empty for the local disk. TeamSpeak 3 only. */
  VirtualServerFileStorageClass: "virtualserver_file_storage_class",
  /** `virtualserver_status`: Status of the virtual server (online | online virtual | offline | booting up | shutting down); see `VirtualServerStatus`. Editable. */
  VirtualServerStatus: "virtualserver_status",
  /** `connection_filetransfer_bandwidth_sent`: Current file transfer upload speed, in bytes per second. Also in hostinfo and clientinfo. */
  ConnectionFileTransferBandwidthSent: "connection_filetransfer_bandwidth_sent",
  /** `connection_filetransfer_bandwidth_received`: Current file transfer download speed, in bytes per second. Also in hostinfo and clientinfo. */
  ConnectionFileTransferBandwidthReceived: "connection_filetransfer_bandwidth_received",
  /** `connection_filetransfer_bytes_sent_total`: Total bytes sent by file transfers since the server started. Also in hostinfo. */
  ConnectionFileTransferBytesSentTotal: "connection_filetransfer_bytes_sent_total",
  /** `connection_filetransfer_bytes_received_total`: Total bytes received by file transfers since the server started. Also in hostinfo. */
  ConnectionFileTransferBytesReceivedTotal: "connection_filetransfer_bytes_received_total",
  /** `connection_packets_sent_speech`: Voice packets sent since the server started. */
  ConnectionPacketsSentSpeech: "connection_packets_sent_speech",
  /** `connection_bytes_sent_speech`: Bytes of voice packets sent since the server started. */
  ConnectionBytesSentSpeech: "connection_bytes_sent_speech",
  /** `connection_packets_received_speech`: Voice packets received since the server started. */
  ConnectionPacketsReceivedSpeech: "connection_packets_received_speech",
  /** `connection_bytes_received_speech`: Bytes of voice packets received since the server started. */
  ConnectionBytesReceivedSpeech: "connection_bytes_received_speech",
  /** `connection_packets_sent_keepalive`: Keepalive packets sent since the server started. */
  ConnectionPacketsSentKeepAlive: "connection_packets_sent_keepalive",
  /** `connection_bytes_sent_keepalive`: Bytes of keepalive packets sent since the server started. */
  ConnectionBytesSentKeepAlive: "connection_bytes_sent_keepalive",
  /** `connection_packets_received_keepalive`: Keepalive packets received since the server started. */
  ConnectionPacketsReceivedKeepAlive: "connection_packets_received_keepalive",
  /** `connection_bytes_received_keepalive`: Bytes of keepalive packets received since the server started. */
  ConnectionBytesReceivedKeepAlive: "connection_bytes_received_keepalive",
  /** `connection_packets_sent_control`: Control (command) packets sent since the server started. */
  ConnectionPacketsSentControl: "connection_packets_sent_control",
  /** `connection_bytes_sent_control`: Bytes of control packets sent since the server started. */
  ConnectionBytesSentControl: "connection_bytes_sent_control",
  /** `connection_packets_received_control`: Control packets received since the server started. */
  ConnectionPacketsReceivedControl: "connection_packets_received_control",
  /** `connection_bytes_received_control`: Bytes of control packets received since the server started. */
  ConnectionBytesReceivedControl: "connection_bytes_received_control",
  /** `connection_packets_sent_total`: All packets sent since the server started. Also in hostinfo and clientinfo. */
  ConnectionPacketsSentTotal: "connection_packets_sent_total",
  /** `connection_bytes_sent_total`: All bytes sent since the server started. Also in hostinfo and clientinfo. */
  ConnectionBytesSentTotal: "connection_bytes_sent_total",
  /** `connection_packets_received_total`: All packets received since the server started. Also in hostinfo and clientinfo. */
  ConnectionPacketsReceivedTotal: "connection_packets_received_total",
  /** `connection_bytes_received_total`: All bytes received since the server started. Also in hostinfo and clientinfo. */
  ConnectionBytesReceivedTotal: "connection_bytes_received_total",
  /** `connection_bandwidth_sent_last_second_total`: Bytes per second sent, averaged over the last second. Also in hostinfo and clientinfo. */
  ConnectionBandwidthSentLastSecondTotal: "connection_bandwidth_sent_last_second_total",
  /** `connection_bandwidth_sent_last_minute_total`: Bytes per second sent, averaged over the last minute. Also in hostinfo and clientinfo. */
  ConnectionBandwidthSentLastMinuteTotal: "connection_bandwidth_sent_last_minute_total",
  /** `connection_bandwidth_received_last_second_total`: Bytes per second received, averaged over the last second. Also in hostinfo and clientinfo. */
  ConnectionBandwidthReceivedLastSecondTotal: "connection_bandwidth_received_last_second_total",
  /** `connection_bandwidth_received_last_minute_total`: Bytes per second received, averaged over the last minute. Also in hostinfo and clientinfo. */
  ConnectionBandwidthReceivedLastMinuteTotal: "connection_bandwidth_received_last_minute_total",
  /** `virtualserver_address`: Public address of the server. TeamSpeak 6 only. */
  VirtualServerAddress: "virtualserver_address",
  /** `virtualserver_administrative_domain`: Administrative domain of the server. TeamSpeak 6 only. */
  VirtualServerAdministrativeDomain: "virtualserver_administrative_domain",
  /** `virtualserver_canonical_name`: Canonical name of the server. TeamSpeak 6 only. */
  VirtualServerCanonicalName: "virtualserver_canonical_name",
  /** `virtualserver_homebase_storage_quota`: Storage quota for homebase data, in bytes; 4294967295 means unlimited. TeamSpeak 6 only. */
  VirtualServerHomeBaseStorageQuota: "virtualserver_homebase_storage_quota",
  /** `virtualserver_homebases`: Number of homebase users on this server. TeamSpeak 6 only. */
  VirtualServerHomeBases: "virtualserver_homebases",
  /** `virtualserver_max_homebases`: Maximum number of homebase users this server accepts. TeamSpeak 6 only. */
  VirtualServerMaxHomeBases: "virtualserver_max_homebases",
  /** `virtualserver_mytsid_connect_only`: 1 if only clients with a MyTeamSpeak id may connect, 0 if not. TeamSpeak 6 only. */
  VirtualServerMyTSIDConnectOnly: "virtualserver_mytsid_connect_only",
  /** `virtualserver_sfu_endpoint`: Address of the server's SFU endpoint; empty if none. TeamSpeak 6 only. */
  VirtualServerSFUEndpoint: "virtualserver_sfu_endpoint",
  /** `virtualserver_storage_quota`: Total file storage quota of the server, in bytes; 4294967295 means unlimited. TeamSpeak 6 only. */
  VirtualServerStorageQuota: "virtualserver_storage_quota",
  /** `virtualserver_version_sign`: Signature that proves the server's version string is genuine, base64. TeamSpeak 6 only. */
  VirtualServerVersionSign: "virtualserver_version_sign",
  // Server instance: instanceinfo, and instanceedit for those marked editable.
  /** `serverinstance_database_version`: Revision of the server database schema. */
  ServerInstanceDatabaseVersion: "serverinstance_database_version",
  /** `serverinstance_filetransfer_port`: TCP port of the file transfer service. Editable. */
  ServerInstanceFileTransferPort: "serverinstance_filetransfer_port",
  /** `serverinstance_max_download_total_bandwidth`: Maximum bandwidth of file transfer downloads for the whole instance, in bytes per second. Editable. */
  ServerInstanceMaxDownloadTotalBandwidth: "serverinstance_max_download_total_bandwidth",
  /** `serverinstance_max_upload_total_bandwidth`: Maximum bandwidth of file transfer uploads for the whole instance, in bytes per second. Editable. */
  ServerInstanceMaxUploadTotalBandwidth: "serverinstance_max_upload_total_bandwidth",
  /** `serverinstance_guest_serverquery_group`: Id of the server group given to ServerQuery clients that have not logged in. Editable. */
  ServerInstanceGuestServerQueryGroup: "serverinstance_guest_serverquery_group",
  /** `serverinstance_serverquery_flood_commands`: Commands a ServerQuery client may send within the flood time before it is banned. Editable. */
  ServerInstanceServerQueryFloodCommands: "serverinstance_serverquery_flood_commands",
  /** `serverinstance_serverquery_flood_time`: Time window, in seconds, in which ServerQuery commands are counted against the flood limit. Editable. */
  ServerInstanceServerQueryFloodTime: "serverinstance_serverquery_flood_time",
  /** `serverinstance_serverquery_ban_time`: How long, in seconds, a ServerQuery client is banned for flooding. Editable. */
  ServerInstanceServerQueryBanTime: "serverinstance_serverquery_ban_time",
  /** `serverinstance_template_serveradmin_group`: Id of the template server group used for server admins of new virtual servers. Editable. */
  ServerInstanceTemplateServerAdminGroup: "serverinstance_template_serveradmin_group",
  /** `serverinstance_template_serverdefault_group`: Id of the template server group used as the default group of new virtual servers. Editable. */
  ServerInstanceTemplateServerDefaultGroup: "serverinstance_template_serverdefault_group",
  /** `serverinstance_template_channeladmin_group`: Id of the template channel group used for channel admins of new virtual servers. Editable. */
  ServerInstanceTemplateChannelAdminGroup: "serverinstance_template_channeladmin_group",
  /** `serverinstance_template_channeldefault_group`: Id of the template channel group used as the default channel group of new virtual servers. Editable. */
  ServerInstanceTemplateChannelDefaultGroup: "serverinstance_template_channeldefault_group",
  /** `serverinstance_permissions_version`: Revision of the permission set the server knows. */
  ServerInstancePermissionsVersion: "serverinstance_permissions_version",
  /** `serverinstance_pending_connections_per_ip`: Connections an IP address may have waiting to finish connecting; 0 means no limit. Editable. */
  ServerInstancePendingConnectionsPerIP: "serverinstance_pending_connections_per_ip",
  /** `serverinstance_serverquery_max_connections_per_ip`: ServerQuery connections one IP address may hold open at the same time. Editable. */
  ServerInstanceServerQueryMaxConnectionsPerIP: "serverinstance_serverquery_max_connections_per_ip",
  /** `serverinstance_max_homebases`: Maximum number of homebase users across the instance; -1 means unlimited. Editable. TeamSpeak 6 only. */
  ServerInstanceMaxHomeBases: "serverinstance_max_homebases",
  // Host: hostinfo.
  /** `instance_uptime`: Seconds since the server instance started. */
  InstanceUptime: "instance_uptime",
  /** `host_timestamp_utc`: The server's current time, as a Unix timestamp in seconds. */
  HostTimestampUTC: "host_timestamp_utc",
  /** `virtualservers_running_total`: Number of virtual servers running. */
  VirtualServersRunningTotal: "virtualservers_running_total",
  /** `virtualservers_total_maxclients`: Sum of the client limits of all running virtual servers. */
  VirtualServersTotalMaxClients: "virtualservers_total_maxclients",
  /** `virtualservers_total_clients_online`: Clients online across all virtual servers. */
  VirtualServersTotalClientsOnline: "virtualservers_total_clients_online",
  /** `virtualservers_total_channels_online`: Channels across all virtual servers. */
  VirtualServersTotalChannelsOnline: "virtualservers_total_channels_online",
  /** `virtualservers_total_homebases`: Number of homebase users across all virtual servers. TeamSpeak 6 only. */
  VirtualServersTotalHomeBases: "virtualservers_total_homebases",
  /** `virtualservers_total_max_homebases`: Maximum number of homebase users across all virtual servers; -1 means unlimited. TeamSpeak 6 only. */
  VirtualServersTotalMaxHomeBases: "virtualservers_total_max_homebases",
  // Client: clientinfo.
  /** `cid`: Id of the channel the client is in. */
  CID: "cid",
  /** `client_idle_time`: Milliseconds since the client was last active. */
  ClientIdleTime: "client_idle_time",
  /** `client_unique_identifier`: The client's unique id, derived from its identity; a ServerQuery client has its login name. */
  ClientUniqueIdentifier: "client_unique_identifier",
  /** `client_nickname`: Nickname of the client. Editable. */
  ClientNickname: "client_nickname",
  /** `client_version`: Client version and build as the client reports it. */
  ClientVersion: "client_version",
  /** `client_platform`: Operating system the client reports, such as Windows. */
  ClientPlatform: "client_platform",
  /** `client_input_muted`: 1 if the client's microphone is muted, 0 if not. */
  ClientInputMuted: "client_input_muted",
  /** `client_output_muted`: 1 if the client's speakers are muted, 0 if not. */
  ClientOutputMuted: "client_output_muted",
  /** `client_outputonly_muted`: 1 if the client has muted all other clients' sound but not its own, 0 if not. */
  ClientOutputOnlyMuted: "client_outputonly_muted",
  /** `client_input_hardware`: 1 if the client has a working capture device, 0 if not. */
  ClientInputHardware: "client_input_hardware",
  /** `client_output_hardware`: 1 if the client has a working playback device, 0 if not. */
  ClientOutputHardware: "client_output_hardware",
  /** `client_default_channel`: Path of the channel the client asked to join first; empty for none. */
  ClientDefaultChannel: "client_default_channel",
  /** `client_meta_data`: Free-form data the client attaches to itself. */
  ClientMetaData: "client_meta_data",
  /** `client_is_recording`: 1 if the client is recording the conversation, 0 if not. */
  ClientIsRecording: "client_is_recording",
  /** `client_version_sign`: Signature that proves the client's version string is genuine, base64. */
  ClientVersionSign: "client_version_sign",
  /** `client_security_hash`: The client's security hash; empty if it sent none. */
  ClientSecurityHash: "client_security_hash",
  /** `client_is_streaming`: 1 if the client is streaming, 0 if not. TeamSpeak 6 only. */
  ClientIsStreaming: "client_is_streaming",
  /** `client_login_name`: ServerQuery login name the client logged in with; empty for voice clients. */
  ClientLoginName: "client_login_name",
  /** `client_database_id`: The client's id in the server database. */
  ClientDatabaseID: "client_database_id",
  /** `client_channel_group_id`: Id of the client's channel group in its current channel. */
  ClientChannelGroupID: "client_channel_group_id",
  /** `client_servergroups`: Ids of the client's server groups, separated by commas. */
  ClientServerGroups: "client_servergroups",
  /** `client_created`: When the client first connected, as a Unix timestamp in seconds. */
  ClientCreated: "client_created",
  /** `client_lastconnected`: When the client last connected, as a Unix timestamp in seconds. */
  ClientLastConnected: "client_lastconnected",
  /** `client_totalconnections`: How many times the client has connected. */
  ClientTotalConnections: "client_totalconnections",
  /** `client_away`: 1 if the client is away, 0 if not. */
  ClientAway: "client_away",
  /** `client_away_message`: The client's away message. */
  ClientAwayMessage: "client_away_message",
  /** `client_type`: 0 for a voice client, 1 for a ServerQuery client. */
  ClientType: "client_type",
  /** `client_flag_avatar`: Checksum of the client's avatar file; empty if it has none. */
  ClientFlagAvatar: "client_flag_avatar",
  /** `client_talk_power`: The client's talk power in its channel. */
  ClientTalkPower: "client_talk_power",
  /** `client_talk_request`: Nonzero if the client has asked for talk power in a moderated channel, 0 if not. */
  ClientTalkRequest: "client_talk_request",
  /** `client_talk_request_msg`: Message that came with the client's request for talk power. */
  ClientTalkRequestMsg: "client_talk_request_msg",
  /** `client_description`: Brief description of the client (max 200 chars). Editable. */
  ClientDescription: "client_description",
  /** `client_is_talker`: Indicates whether the client is able to talk or not. Editable. */
  ClientIsTalker: "client_is_talker",
  /** `client_month_bytes_uploaded`: Bytes of file transfer uploads by the client this month. */
  ClientMonthBytesUploaded: "client_month_bytes_uploaded",
  /** `client_month_bytes_downloaded`: Bytes of file transfer downloads by the client this month. */
  ClientMonthBytesDownloaded: "client_month_bytes_downloaded",
  /** `client_total_bytes_uploaded`: Bytes of file transfer uploads by the client in total. */
  ClientTotalBytesUploaded: "client_total_bytes_uploaded",
  /** `client_total_bytes_downloaded`: Bytes of file transfer downloads by the client in total. */
  ClientTotalBytesDownloaded: "client_total_bytes_downloaded",
  /** `client_is_priority_speaker`: 1 if the client is a priority speaker, 0 if not. */
  ClientIsPrioritySpeaker: "client_is_priority_speaker",
  /** `client_unread_messages`: Number of offline messages the client has not read. */
  ClientUnreadMessages: "client_unread_messages",
  /** `client_nickname_phonetic`: Phonetic spelling of the client's nickname. */
  ClientNicknamePhonetic: "client_nickname_phonetic",
  /** `client_needed_serverquery_view_power`: Power a ServerQuery client needs to see this client. */
  ClientNeededServerQueryViewPower: "client_needed_serverquery_view_power",
  /** `client_default_token`: Privilege key the client used to connect, if any. */
  ClientDefaultToken: "client_default_token",
  /** `client_icon_id`: CRC32 checksum of the client icon. Editable. */
  ClientIconID: "client_icon_id",
  /** `client_is_channel_commander`: Indicates whether the client is a channel commander or not. Editable. */
  ClientIsChannelCommander: "client_is_channel_commander",
  /** `client_country`: Two-letter country code of the client; empty if unknown. */
  ClientCountry: "client_country",
  /** `client_channel_group_inherited_channel_id`: Id of the channel the client's channel group applies from, which is an ancestor when the group is inherited. */
  ClientChannelGroupInheritedChannelID: "client_channel_group_inherited_channel_id",
  /** `client_badges`: Badges the client shows, as a string. */
  ClientBadges: "client_badges",
  /** `client_myteamspeak_id`: The client's MyTeamSpeak id; empty if it is not logged in. */
  ClientMyTeamSpeakID: "client_myteamspeak_id",
  /** `client_integrations`: Integrations the client has linked to its MyTeamSpeak account; empty for none. */
  ClientIntegrations: "client_integrations",
  /** `client_myteamspeak_avatar`: Checksum of the client's MyTeamSpeak avatar; empty for none. */
  ClientMyTeamSpeakAvatar: "client_myteamspeak_avatar",
  /** `client_signed_badges`: Badges the client shows, signed by TeamSpeak. */
  ClientSignedBadges: "client_signed_badges",
  /** `client_user_tag`: Free-form tag the user has set for itself. TeamSpeak 6 only. */
  ClientUserTag: "client_user_tag",
  /** `client_public_key_raw`: The client's raw public key, base64. TeamSpeak 6 only. */
  ClientPublicKeyRaw: "client_public_key_raw",
  /** `client_base64HashClientUID`: The client's unique id hashed and re-encoded with the letters a to p, the form the TeamSpeak client uses to name its avatar files. */
  ClientBase64HashClientUID: "client_base64HashClientUID",
  /** `connection_connected_time`: Milliseconds since the client connected. */
  ConnectionConnectedTime: "connection_connected_time",
  /** `connection_client_ip`: The client's IP address. */
  ConnectionClientIP: "connection_client_ip",
} as const;

/** The property names; see {@link PropertyName}'s entries for what each holds. */
export const PropertyName: typeof propertyNameValues =
  /* @__PURE__ */ Object.freeze(propertyNameValues);

/** A property name a TeamSpeak 3.13 or 6 server reports. */
export type PropertyName = (typeof PropertyName)[keyof typeof PropertyName];
