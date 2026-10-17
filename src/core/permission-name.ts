/**
 * The permissions a TeamSpeak server checks, by name, for
 * {@link permissionByName}:
 *
 * ```ts
 * await addChannelPermission(client, cid, permissionByName(PermissionName.ClientNeededTalkPower), 50);
 * ```
 *
 * These are the names TeamSpeak 3.13 and 6 servers list, in the order they
 * list them, measured with `permissionlist`; the fourteen marked TeamSpeak 6 only
 * are missing on TeamSpeak 3. Every permission has a twin,
 * `i_needed_modify_power_` followed by its name, which sets the modify power
 * needed to change it; those are the second block, named `NeededModifyPower`
 * followed by the permission's own name. A name starting `b_` is a switch, granted or
 * not; one starting `i_` is a value, such as a power compared with a needed
 * power. A server may know permissions this table does not, which is why
 * `permissionByName` takes any string.
 */
const permissionNameValues = {
  /** `b_serverinstance_help_view`: Retrieve information about ServerQuery commands. */
  ServerInstanceHelpView: "b_serverinstance_help_view",
  /** `b_serverinstance_info_view`: Retrieve global server information. */
  ServerInstanceInfoView: "b_serverinstance_info_view",
  /** `b_serverinstance_virtualserver_list`: List virtual servers stored in the database. */
  ServerInstanceVirtualServerList: "b_serverinstance_virtualserver_list",
  /** `b_serverinstance_binding_list`: List active IP bindings on multi-homed machines. */
  ServerInstanceBindingList: "b_serverinstance_binding_list",
  /** `b_serverinstance_permission_list`: List permissions available on the server instance. */
  ServerInstancePermissionList: "b_serverinstance_permission_list",
  /** `b_serverinstance_permission_find`: Search permission assignments by name or ID. */
  ServerInstancePermissionFind: "b_serverinstance_permission_find",
  /** `b_virtualserver_create`: Create virtual servers. */
  VirtualServerCreate: "b_virtualserver_create",
  /** `b_virtualserver_delete`: Delete virtual servers. */
  VirtualServerDelete: "b_virtualserver_delete",
  /** `b_virtualserver_start_any`: Start any virtual server in the server instance. */
  VirtualServerStartAny: "b_virtualserver_start_any",
  /** `b_virtualserver_stop_any`: Stop any virtual server in the server instance. */
  VirtualServerStopAny: "b_virtualserver_stop_any",
  /** `b_virtualserver_change_machine_id`: Change a virtual servers machine ID. */
  VirtualServerChangeMachineID: "b_virtualserver_change_machine_id",
  /** `b_virtualserver_change_template`: Edit virtual server default template values. */
  VirtualServerChangeTemplate: "b_virtualserver_change_template",
  /** `b_serverquery_login`: Login to ServerQuery. */
  ServerQueryLogin: "b_serverquery_login",
  /** `b_serverquery_login_create`: Create a new server query login. */
  ServerQueryLoginCreate: "b_serverquery_login_create",
  /** `b_serverquery_login_delete`: Delete a server query login. */
  ServerQueryLoginDelete: "b_serverquery_login_delete",
  /** `b_serverquery_login_list`: List server query logins. */
  ServerQueryLoginList: "b_serverquery_login_list",
  /** `b_serverinstance_textmessage_send`: Send text messages to all virtual servers at once. */
  ServerInstanceTextMessageSend: "b_serverinstance_textmessage_send",
  /** `b_serverinstance_log_view`: Retrieve global server log. */
  ServerInstanceLogView: "b_serverinstance_log_view",
  /** `b_serverinstance_log_add`: Write to global server log. */
  ServerInstanceLogAdd: "b_serverinstance_log_add",
  /** `b_serverinstance_stop`: Shutdown the server process. */
  ServerInstanceStop: "b_serverinstance_stop",
  /** `b_serverinstance_licensesign_message`: Sign arbitrary message with license key. TeamSpeak 6 only. */
  ServerInstanceLicenseSignMessage: "b_serverinstance_licensesign_message",
  /** `b_serverinstance_modify_settings`: Edit global settings. */
  ServerInstanceModifySettings: "b_serverinstance_modify_settings",
  /** `b_serverinstance_modify_querygroup`: Edit global ServerQuery groups. */
  ServerInstanceModifyQueryGroup: "b_serverinstance_modify_querygroup",
  /** `b_serverinstance_modify_templates`: Edit global template groups. */
  ServerInstanceModifyTemplates: "b_serverinstance_modify_templates",
  /** `b_virtualserver_select`: Select a virtual server. */
  VirtualServerSelect: "b_virtualserver_select",
  /** `b_virtualserver_info_view`: Retrieve virtual server information. */
  VirtualServerInfoView: "b_virtualserver_info_view",
  /** `b_virtualserver_connectioninfo_view`: Retrieve virtual server connection information. */
  VirtualServerConnectionInfoView: "b_virtualserver_connectioninfo_view",
  /** `b_virtualserver_channel_list`: List channels on a virtual server. */
  VirtualServerChannelList: "b_virtualserver_channel_list",
  /** `b_virtualserver_channel_search`: Search for channels on a virtual server. */
  VirtualServerChannelSearch: "b_virtualserver_channel_search",
  /** `b_virtualserver_client_list`: List clients online on a virtual server. */
  VirtualServerClientList: "b_virtualserver_client_list",
  /** `b_virtualserver_client_search`: Search for clients online on a virtual server. */
  VirtualServerClientSearch: "b_virtualserver_client_search",
  /** `b_virtualserver_client_dblist`: List client identities known by the virtual server. */
  VirtualServerClientDBList: "b_virtualserver_client_dblist",
  /** `b_virtualserver_client_dbsearch`: Search for client identities known by the virtual server. */
  VirtualServerClientDBSearch: "b_virtualserver_client_dbsearch",
  /** `b_virtualserver_client_dbinfo`: Retrieve client information. */
  VirtualServerClientDBInfo: "b_virtualserver_client_dbinfo",
  /** `b_virtualserver_permission_find`: Find permissions. */
  VirtualServerPermissionFind: "b_virtualserver_permission_find",
  /** `b_virtualserver_custom_search`: Find custom fields. */
  VirtualServerCustomSearch: "b_virtualserver_custom_search",
  /** `b_virtualserver_start`: Start own virtual server. */
  VirtualServerStart: "b_virtualserver_start",
  /** `b_virtualserver_stop`: Stop own virtual server. */
  VirtualServerStop: "b_virtualserver_stop",
  /** `b_virtualserver_token_list`: List privilege keys available. */
  VirtualServerTokenList: "b_virtualserver_token_list",
  /** `b_virtualserver_token_add`: Create new privilege keys. */
  VirtualServerTokenAdd: "b_virtualserver_token_add",
  /** `b_virtualserver_token_use`: Use a privilege keys to gain access to groups. */
  VirtualServerTokenUse: "b_virtualserver_token_use",
  /** `b_virtualserver_token_delete`: Delete a privilege key. */
  VirtualServerTokenDelete: "b_virtualserver_token_delete",
  /** `b_virtualserver_apikey_add`: Create a new API key. */
  VirtualServerAPIKeyAdd: "b_virtualserver_apikey_add",
  /** `b_virtualserver_apikey_manage`: Manage existing API keys. */
  VirtualServerAPIKeyManage: "b_virtualserver_apikey_manage",
  /** `b_virtualserver_log_view`: Retrieve virtual server log. */
  VirtualServerLogView: "b_virtualserver_log_view",
  /** `b_virtualserver_log_add`: Write to virtual server log. */
  VirtualServerLogAdd: "b_virtualserver_log_add",
  /** `b_virtualserver_join_ignore_password`: Join virtual server ignoring its password. */
  VirtualServerJoinIgnorePassword: "b_virtualserver_join_ignore_password",
  /** `b_virtualserver_notify_register`: Register for server notifications. */
  VirtualServerNotifyRegister: "b_virtualserver_notify_register",
  /** `b_virtualserver_notify_unregister`: Unregister from server notifications. */
  VirtualServerNotifyUnregister: "b_virtualserver_notify_unregister",
  /** `b_virtualserver_snapshot_create`: Create server snapshots. */
  VirtualServerSnapshotCreate: "b_virtualserver_snapshot_create",
  /** `b_virtualserver_snapshot_deploy`: Deploy server snapshots. */
  VirtualServerSnapshotDeploy: "b_virtualserver_snapshot_deploy",
  /** `b_virtualserver_permission_reset`: Reset the server permission settings to default values. */
  VirtualServerPermissionReset: "b_virtualserver_permission_reset",
  /** `b_virtualserver_canonical_name_manage`: Manage canonical name of the virtual server. TeamSpeak 6 only. */
  VirtualServerCanonicalNameManage: "b_virtualserver_canonical_name_manage",
  /** `b_virtualserver_modify_name`: Modify server name. */
  VirtualServerModifyName: "b_virtualserver_modify_name",
  /** `b_virtualserver_modify_welcomemessage`: Modify welcome message. */
  VirtualServerModifyWelcomeMessage: "b_virtualserver_modify_welcomemessage",
  /** `b_virtualserver_modify_maxclients`: Modify servers max clients. */
  VirtualServerModifyMaxClients: "b_virtualserver_modify_maxclients",
  /** `b_virtualserver_modify_reserved_slots`: Modify reserved slots. */
  VirtualServerModifyReservedSlots: "b_virtualserver_modify_reserved_slots",
  /** `b_virtualserver_modify_password`: Modify server password. */
  VirtualServerModifyPassword: "b_virtualserver_modify_password",
  /** `b_virtualserver_modify_default_servergroup`: Modify default Server Group. */
  VirtualServerModifyDefaultServerGroup: "b_virtualserver_modify_default_servergroup",
  /** `b_virtualserver_modify_default_channelgroup`: Modify default Channel Group. */
  VirtualServerModifyDefaultChannelGroup: "b_virtualserver_modify_default_channelgroup",
  /** `b_virtualserver_modify_default_channeladmingroup`: Modify default Channel Admin Group. */
  VirtualServerModifyDefaultChannelAdminGroup: "b_virtualserver_modify_default_channeladmingroup",
  /** `b_virtualserver_modify_channel_forced_silence`: Modify channel force silence value. */
  VirtualServerModifyChannelForcedSilence: "b_virtualserver_modify_channel_forced_silence",
  /** `b_virtualserver_modify_complain`: Modify individual complain settings. */
  VirtualServerModifyComplain: "b_virtualserver_modify_complain",
  /** `b_virtualserver_modify_antiflood`: Modify individual antiflood settings. */
  VirtualServerModifyAntiflood: "b_virtualserver_modify_antiflood",
  /** `b_virtualserver_modify_ft_settings`: Modify file transfer settings. */
  VirtualServerModifyFTSettings: "b_virtualserver_modify_ft_settings",
  /** `b_virtualserver_modify_ft_quotas`: Modify file transfer quotas. */
  VirtualServerModifyFTQuotas: "b_virtualserver_modify_ft_quotas",
  /** `b_virtualserver_modify_hostmessage`: Modify individual hostmessage settings. */
  VirtualServerModifyHostMessage: "b_virtualserver_modify_hostmessage",
  /** `b_virtualserver_modify_hostbanner`: Modify individual hostbanner settings. */
  VirtualServerModifyHostBanner: "b_virtualserver_modify_hostbanner",
  /** `b_virtualserver_modify_hostbutton`: Modify individual hostbutton settings. */
  VirtualServerModifyHostButton: "b_virtualserver_modify_hostbutton",
  /** `b_virtualserver_modify_port`: Modify server port. */
  VirtualServerModifyPort: "b_virtualserver_modify_port",
  /** `b_virtualserver_modify_autostart`: Modify server autostart. */
  VirtualServerModifyAutoStart: "b_virtualserver_modify_autostart",
  /** `b_virtualserver_modify_needed_identity_security_level`: Modify required identity security level. */
  VirtualServerModifyNeededIdentitySecurityLevel:
    "b_virtualserver_modify_needed_identity_security_level",
  /** `b_virtualserver_modify_priority_speaker_dimm_modificator`: Modify priority speaker dimm modificator. */
  VirtualServerModifyPrioritySpeakerDimmModificator:
    "b_virtualserver_modify_priority_speaker_dimm_modificator",
  /** `b_virtualserver_modify_log_settings`: Modify log settings. */
  VirtualServerModifyLogSettings: "b_virtualserver_modify_log_settings",
  /** `b_virtualserver_modify_min_client_version`: Modify min client version. */
  VirtualServerModifyMinClientVersion: "b_virtualserver_modify_min_client_version",
  /** `b_virtualserver_modify_icon_id`: Modify server icon. */
  VirtualServerModifyIconID: "b_virtualserver_modify_icon_id",
  /** `b_virtualserver_modify_weblist`: Modify web server list reporting settings. */
  VirtualServerModifyWebList: "b_virtualserver_modify_weblist",
  /** `b_virtualserver_modify_codec_encryption_mode`: Modify codec encryption mode. */
  VirtualServerModifyCodecEncryptionMode: "b_virtualserver_modify_codec_encryption_mode",
  /** `b_virtualserver_modify_temporary_passwords`: Modify temporary serverpasswords. */
  VirtualServerModifyTemporaryPasswords: "b_virtualserver_modify_temporary_passwords",
  /** `b_virtualserver_modify_temporary_passwords_own`: Modify own temporary serverpasswords. */
  VirtualServerModifyTemporaryPasswordsOwn: "b_virtualserver_modify_temporary_passwords_own",
  /** `b_virtualserver_modify_channel_temp_delete_delay_default`: Modify default temporary channel delete delay. */
  VirtualServerModifyChannelTempDeleteDelayDefault:
    "b_virtualserver_modify_channel_temp_delete_delay_default",
  /** `b_virtualserver_modify_nickname`: Modify server nicknames. */
  VirtualServerModifyNickname: "b_virtualserver_modify_nickname",
  /** `b_virtualserver_modify_integrations`: Modify integrations. */
  VirtualServerModifyIntegrations: "b_virtualserver_modify_integrations",
  /** `b_virtualserver_modify_mytsid_connect`: Modify mytsid connect. TeamSpeak 6 only. */
  VirtualServerModifyMyTSIDConnect: "b_virtualserver_modify_mytsid_connect",
  /** `i_channel_min_depth`: Min channel creation depth in hierarchy. */
  ChannelMinDepth: "i_channel_min_depth",
  /** `i_channel_max_depth`: Max channel creation depth in hierarchy. */
  ChannelMaxDepth: "i_channel_max_depth",
  /** `b_channel_group_inheritance_end`: Stop inheritance of channel group permissions. */
  ChannelGroupInheritanceEnd: "b_channel_group_inheritance_end",
  /** `i_channel_permission_modify_power`: Modify channel permission power. */
  ChannelPermissionModifyPower: "i_channel_permission_modify_power",
  /** `i_channel_needed_permission_modify_power`: Needed modify channel permission power. */
  ChannelNeededPermissionModifyPower: "i_channel_needed_permission_modify_power",
  /** `b_channel_info_view`: Retrieve channel information. */
  ChannelInfoView: "b_channel_info_view",
  /** `b_channel_create_child`: Create sub-channels. */
  ChannelCreateChild: "b_channel_create_child",
  /** `b_channel_create_permanent`: Create permanent channels. */
  ChannelCreatePermanent: "b_channel_create_permanent",
  /** `b_channel_create_semi_permanent`: Create semi-permanent channels. */
  ChannelCreateSemiPermanent: "b_channel_create_semi_permanent",
  /** `b_channel_create_temporary`: Create temporary channels. */
  ChannelCreateTemporary: "b_channel_create_temporary",
  /** `b_channel_create_with_topic`: Create channels with a topic. */
  ChannelCreateWithTopic: "b_channel_create_with_topic",
  /** `b_channel_create_with_description`: Create channels with a description. */
  ChannelCreateWithDescription: "b_channel_create_with_description",
  /** `b_channel_create_with_password`: Create password protected channels. */
  ChannelCreateWithPassword: "b_channel_create_with_password",
  /** `b_channel_create_with_banner`: Create channel with a banner. */
  ChannelCreateWithBanner: "b_channel_create_with_banner",
  /** `b_channel_create_modify_with_codec_opusvoice`: Create channels using OPUS (voice) codec. */
  ChannelCreateModifyWithCodecOpusVoice: "b_channel_create_modify_with_codec_opusvoice",
  /** `b_channel_create_modify_with_codec_opusmusic`: Create channels using OPUS (music) codec. */
  ChannelCreateModifyWithCodecOpusMusic: "b_channel_create_modify_with_codec_opusmusic",
  /** `i_channel_create_modify_with_codec_maxquality`: Create channels with custom codec quality. */
  ChannelCreateModifyWithCodecMaxQuality: "i_channel_create_modify_with_codec_maxquality",
  /** `i_channel_create_modify_with_codec_latency_factor_min`: Create channels with minimal custom codec latency factor. */
  ChannelCreateModifyWithCodecLatencyFactorMin:
    "i_channel_create_modify_with_codec_latency_factor_min",
  /** `b_channel_create_with_maxclients`: Create channels with custom max clients. */
  ChannelCreateWithMaxClients: "b_channel_create_with_maxclients",
  /** `b_channel_create_with_maxfamilyclients`: Create channels with custom max family clients. */
  ChannelCreateWithMaxFamilyClients: "b_channel_create_with_maxfamilyclients",
  /** `b_channel_create_with_sortorder`: Create channels with custom sort order. */
  ChannelCreateWithSortOrder: "b_channel_create_with_sortorder",
  /** `b_channel_create_with_default`: Create default channels. */
  ChannelCreateWithDefault: "b_channel_create_with_default",
  /** `b_channel_create_with_needed_talk_power`: Create channels with needed talk power. */
  ChannelCreateWithNeededTalkPower: "b_channel_create_with_needed_talk_power",
  /** `b_channel_create_modify_with_force_password`: Create new channels only with password. */
  ChannelCreateModifyWithForcePassword: "b_channel_create_modify_with_force_password",
  /** `i_channel_create_modify_with_temp_delete_delay`: Max delete delay for temporary channels. */
  ChannelCreateModifyWithTempDeleteDelay: "i_channel_create_modify_with_temp_delete_delay",
  /** `b_channel_modify_parent`: Move channels. */
  ChannelModifyParent: "b_channel_modify_parent",
  /** `b_channel_modify_make_default`: Make channel default. */
  ChannelModifyMakeDefault: "b_channel_modify_make_default",
  /** `b_channel_modify_make_permanent`: Make channel permanent. */
  ChannelModifyMakePermanent: "b_channel_modify_make_permanent",
  /** `b_channel_modify_make_semi_permanent`: Make channel semi-permanent. */
  ChannelModifyMakeSemiPermanent: "b_channel_modify_make_semi_permanent",
  /** `b_channel_modify_make_temporary`: Make channel temporary. */
  ChannelModifyMakeTemporary: "b_channel_modify_make_temporary",
  /** `b_channel_modify_name`: Modify channel name. */
  ChannelModifyName: "b_channel_modify_name",
  /** `b_channel_modify_topic`: Modify channel topic. */
  ChannelModifyTopic: "b_channel_modify_topic",
  /** `b_channel_modify_description`: Modify channel description. */
  ChannelModifyDescription: "b_channel_modify_description",
  /** `b_channel_modify_password`: Modify channel password. */
  ChannelModifyPassword: "b_channel_modify_password",
  /** `b_channel_modify_banner`: Modify channel banner. */
  ChannelModifyBanner: "b_channel_modify_banner",
  /** `b_channel_modify_codec`: Modify channel codec. */
  ChannelModifyCodec: "b_channel_modify_codec",
  /** `b_channel_modify_codec_quality`: Modify channel codec quality. */
  ChannelModifyCodecQuality: "b_channel_modify_codec_quality",
  /** `b_channel_modify_codec_latency_factor`: Modify channel codec latency factor. */
  ChannelModifyCodecLatencyFactor: "b_channel_modify_codec_latency_factor",
  /** `b_channel_modify_maxclients`: Modify channels max clients. */
  ChannelModifyMaxClients: "b_channel_modify_maxclients",
  /** `b_channel_modify_maxfamilyclients`: Modify channels max family clients. */
  ChannelModifyMaxFamilyClients: "b_channel_modify_maxfamilyclients",
  /** `b_channel_modify_sortorder`: Modify channel sort order. */
  ChannelModifySortOrder: "b_channel_modify_sortorder",
  /** `b_channel_modify_needed_talk_power`: Change needed channel talk power. */
  ChannelModifyNeededTalkPower: "b_channel_modify_needed_talk_power",
  /** `i_channel_modify_power`: Channel modify power. */
  ChannelModifyPower: "i_channel_modify_power",
  /** `i_channel_needed_modify_power`: Needed channel modify power. */
  ChannelNeededModifyPower: "i_channel_needed_modify_power",
  /** `b_channel_modify_make_codec_encrypted`: Make channel codec encrypted. */
  ChannelModifyMakeCodecEncrypted: "b_channel_modify_make_codec_encrypted",
  /** `b_channel_modify_temp_delete_delay`: Modify temporary channel delete delay. */
  ChannelModifyTempDeleteDelay: "b_channel_modify_temp_delete_delay",
  /** `b_channel_modify_ft_quotas`: Modify file transfer quotas. TeamSpeak 6 only. */
  ChannelModifyFTQuotas: "b_channel_modify_ft_quotas",
  /** `b_channel_delete_permanent`: Delete permanent channels. */
  ChannelDeletePermanent: "b_channel_delete_permanent",
  /** `b_channel_delete_semi_permanent`: Delete semi-permanent channels. */
  ChannelDeleteSemiPermanent: "b_channel_delete_semi_permanent",
  /** `b_channel_delete_temporary`: Delete temporary channels. */
  ChannelDeleteTemporary: "b_channel_delete_temporary",
  /** `b_channel_delete_flag_force`: Force channel delete. */
  ChannelDeleteFlagForce: "b_channel_delete_flag_force",
  /** `i_channel_delete_power`: Delete channel power. */
  ChannelDeletePower: "i_channel_delete_power",
  /** `i_channel_needed_delete_power`: Needed delete channel power. */
  ChannelNeededDeletePower: "i_channel_needed_delete_power",
  /** `b_channel_join_permanent`: Join permanent channels. */
  ChannelJoinPermanent: "b_channel_join_permanent",
  /** `b_channel_join_semi_permanent`: Join semi-permanent channels. */
  ChannelJoinSemiPermanent: "b_channel_join_semi_permanent",
  /** `b_channel_join_temporary`: Join temporary channels. */
  ChannelJoinTemporary: "b_channel_join_temporary",
  /** `b_channel_join_ignore_password`: Join channel ignoring its password. */
  ChannelJoinIgnorePassword: "b_channel_join_ignore_password",
  /** `b_channel_join_ignore_maxclients`: Ignore channels max clients limit. */
  ChannelJoinIgnoreMaxClients: "b_channel_join_ignore_maxclients",
  /** `i_channel_join_power`: Channel join power. */
  ChannelJoinPower: "i_channel_join_power",
  /** `i_channel_needed_join_power`: Needed channel join power. */
  ChannelNeededJoinPower: "i_channel_needed_join_power",
  /** `i_channel_subscribe_power`: Channel subscribe power. */
  ChannelSubscribePower: "i_channel_subscribe_power",
  /** `i_channel_needed_subscribe_power`: Needed channel subscribe power. */
  ChannelNeededSubscribePower: "i_channel_needed_subscribe_power",
  /** `i_channel_description_view_power`: Channel description view power. */
  ChannelDescriptionViewPower: "i_channel_description_view_power",
  /** `i_channel_needed_description_view_power`: Needed channel needed description view power. */
  ChannelNeededDescriptionViewPower: "i_channel_needed_description_view_power",
  /** `i_icon_id`: Group icon identifier. */
  IconID: "i_icon_id",
  /** `i_max_icon_filesize`: Max icon filesize in bytes. */
  MaxIconFileSize: "i_max_icon_filesize",
  /** `b_icon_manage`: Enables icon management. */
  IconManage: "b_icon_manage",
  /** `b_group_is_permanent`: Group is permanent. */
  GroupIsPermanent: "b_group_is_permanent",
  /** `i_group_auto_update_type`: Group auto-update type. */
  GroupAutoUpdateType: "i_group_auto_update_type",
  /** `i_group_auto_update_max_value`: Group auto-update max value. */
  GroupAutoUpdateMaxValue: "i_group_auto_update_max_value",
  /** `i_group_sort_id`: Group sort id. */
  GroupSortID: "i_group_sort_id",
  /** `i_group_show_name_in_tree`: Show group name in tree depending on selected mode. */
  GroupShowNameInTree: "i_group_show_name_in_tree",
  /** `b_virtualserver_servergroup_list`: List server groups. */
  VirtualServerServerGroupList: "b_virtualserver_servergroup_list",
  /** `b_virtualserver_servergroup_permission_list`: List server group permissions. */
  VirtualServerServerGroupPermissionList: "b_virtualserver_servergroup_permission_list",
  /** `b_virtualserver_servergroup_client_list`: List clients from a server group. */
  VirtualServerServerGroupClientList: "b_virtualserver_servergroup_client_list",
  /** `b_virtualserver_channelgroup_list`: List channel groups. */
  VirtualServerChannelGroupList: "b_virtualserver_channelgroup_list",
  /** `b_virtualserver_channelgroup_permission_list`: List channel group permissions. */
  VirtualServerChannelGroupPermissionList: "b_virtualserver_channelgroup_permission_list",
  /** `b_virtualserver_channelgroup_client_list`: List clients from a channel group. */
  VirtualServerChannelGroupClientList: "b_virtualserver_channelgroup_client_list",
  /** `b_virtualserver_client_permission_list`: List client permissions. */
  VirtualServerClientPermissionList: "b_virtualserver_client_permission_list",
  /** `b_virtualserver_channel_permission_list`: List channel permissions. */
  VirtualServerChannelPermissionList: "b_virtualserver_channel_permission_list",
  /** `b_virtualserver_channelclient_permission_list`: List channel client permissions. */
  VirtualServerChannelClientPermissionList: "b_virtualserver_channelclient_permission_list",
  /** `b_virtualserver_servergroup_create`: Create server groups. */
  VirtualServerServerGroupCreate: "b_virtualserver_servergroup_create",
  /** `b_virtualserver_channelgroup_create`: Create channel groups. */
  VirtualServerChannelGroupCreate: "b_virtualserver_channelgroup_create",
  /** `i_group_modify_power`: Group modify power. */
  GroupModifyPower: "i_group_modify_power",
  /** `i_group_needed_modify_power`: Needed group modify power. */
  GroupNeededModifyPower: "i_group_needed_modify_power",
  /** `i_group_member_add_power`: Group member add power. */
  GroupMemberAddPower: "i_group_member_add_power",
  /** `i_group_needed_member_add_power`: Needed group member add power. */
  GroupNeededMemberAddPower: "i_group_needed_member_add_power",
  /** `i_group_member_remove_power`: Group member delete power. */
  GroupMemberRemovePower: "i_group_member_remove_power",
  /** `i_group_needed_member_remove_power`: Needed group member delete power. */
  GroupNeededMemberRemovePower: "i_group_needed_member_remove_power",
  /** `i_permission_modify_power`: Permission modify power. */
  PermissionModifyPower: "i_permission_modify_power",
  /** `b_permission_modify_power_ignore`: Ignore needed permission modify power. */
  PermissionModifyPowerIgnore: "b_permission_modify_power_ignore",
  /** `b_virtualserver_servergroup_delete`: Delete server groups. */
  VirtualServerServerGroupDelete: "b_virtualserver_servergroup_delete",
  /** `b_virtualserver_channelgroup_delete`: Delete channel groups. */
  VirtualServerChannelGroupDelete: "b_virtualserver_channelgroup_delete",
  /** `i_client_permission_modify_power`: Client permission modify power. */
  ClientPermissionModifyPower: "i_client_permission_modify_power",
  /** `i_client_needed_permission_modify_power`: Needed client permission modify power. */
  ClientNeededPermissionModifyPower: "i_client_needed_permission_modify_power",
  /** `i_client_max_clones_uid`: Max additional connections per client identity. */
  ClientMaxClonesUID: "i_client_max_clones_uid",
  /** `i_client_max_idletime`: Max idle time in seconds. */
  ClientMaxIdleTime: "i_client_max_idletime",
  /** `i_client_max_avatar_filesize`: Max avatar filesize in bytes. */
  ClientMaxAvatarFileSize: "i_client_max_avatar_filesize",
  /** `i_client_max_channel_subscriptions`: Max channel subscriptions. */
  ClientMaxChannelSubscriptions: "i_client_max_channel_subscriptions",
  /** `b_client_is_priority_speaker`: Client is priority speaker. */
  ClientIsPrioritySpeaker: "b_client_is_priority_speaker",
  /** `b_client_skip_channelgroup_permissions`: Ignore channel group permissions. */
  ClientSkipChannelGroupPermissions: "b_client_skip_channelgroup_permissions",
  /** `b_client_force_push_to_talk`: Force Push-To-Talk capture mode. */
  ClientForcePushToTalk: "b_client_force_push_to_talk",
  /** `b_client_ignore_bans`: Ignore bans. */
  ClientIgnoreBans: "b_client_ignore_bans",
  /** `b_client_ignore_antiflood`: Ignore antiflood measurements. */
  ClientIgnoreAntiflood: "b_client_ignore_antiflood",
  /** `b_client_use_reserved_slot`: Use an reserved slot. */
  ClientUseReservedSlot: "b_client_use_reserved_slot",
  /** `b_client_use_channel_commander`: Use channel commander. */
  ClientUseChannelCommander: "b_client_use_channel_commander",
  /** `b_client_request_talker`: Allow to request talk power. */
  ClientRequestTalker: "b_client_request_talker",
  /** `b_client_avatar_delete_other`: Allow deletion of avatars from other clients. */
  ClientAvatarDeleteOther: "b_client_avatar_delete_other",
  /** `b_client_is_sticky`: Client will be sticked to current channel. */
  ClientIsSticky: "b_client_is_sticky",
  /** `b_client_ignore_sticky`: Client ignores sticky flag. */
  ClientIgnoreSticky: "b_client_ignore_sticky",
  /** `b_client_info_view`: Retrieve client information. */
  ClientInfoView: "b_client_info_view",
  /** `b_client_permissionoverview_view`: Retrieve client permissions overview. */
  ClientPermissionOverviewView: "b_client_permissionoverview_view",
  /** `b_client_permissionoverview_own`: Retrieve clients own permissions overview. */
  ClientPermissionOverviewOwn: "b_client_permissionoverview_own",
  /** `b_client_remoteaddress_view`: View client IP address and port. */
  ClientRemoteAddressView: "b_client_remoteaddress_view",
  /** `i_client_serverquery_view_power`: ServerQuery view power. */
  ClientServerQueryViewPower: "i_client_serverquery_view_power",
  /** `i_client_needed_serverquery_view_power`: Needed ServerQuery view power. */
  ClientNeededServerQueryViewPower: "i_client_needed_serverquery_view_power",
  /** `b_client_custom_info_view`: View custom fields. */
  ClientCustomInfoView: "b_client_custom_info_view",
  /** `i_client_kick_from_server_power`: Client kick power from server. */
  ClientKickFromServerPower: "i_client_kick_from_server_power",
  /** `i_client_needed_kick_from_server_power`: Needed client kick power from server. */
  ClientNeededKickFromServerPower: "i_client_needed_kick_from_server_power",
  /** `i_client_kick_from_channel_power`: Client kick power from channel. */
  ClientKickFromChannelPower: "i_client_kick_from_channel_power",
  /** `i_client_needed_kick_from_channel_power`: Needed client kick power from channel. */
  ClientNeededKickFromChannelPower: "i_client_needed_kick_from_channel_power",
  /** `i_client_ban_power`: Client ban power. */
  ClientBanPower: "i_client_ban_power",
  /** `i_client_needed_ban_power`: Needed client ban power. */
  ClientNeededBanPower: "i_client_needed_ban_power",
  /** `i_client_move_power`: Client move power. */
  ClientMovePower: "i_client_move_power",
  /** `i_client_needed_move_power`: Needed client move power. */
  ClientNeededMovePower: "i_client_needed_move_power",
  /** `i_client_complain_power`: Complain power. */
  ClientComplainPower: "i_client_complain_power",
  /** `i_client_needed_complain_power`: Needed complain power. */
  ClientNeededComplainPower: "i_client_needed_complain_power",
  /** `b_client_complain_list`: Show complain list. */
  ClientComplainList: "b_client_complain_list",
  /** `b_client_complain_delete_own`: Delete own complains. */
  ClientComplainDeleteOwn: "b_client_complain_delete_own",
  /** `b_client_complain_delete`: Delete complains. */
  ClientComplainDelete: "b_client_complain_delete",
  /** `b_client_ban_list`: Show banlist. */
  ClientBanList: "b_client_ban_list",
  /** `b_client_ban_create`: Add a ban. */
  ClientBanCreate: "b_client_ban_create",
  /** `b_client_ban_delete_own`: Delete own bans. */
  ClientBanDeleteOwn: "b_client_ban_delete_own",
  /** `b_client_ban_delete`: Delete bans. */
  ClientBanDelete: "b_client_ban_delete",
  /** `i_client_ban_max_bantime`: Max bantime. */
  ClientBanMaxBanTime: "i_client_ban_max_bantime",
  /** `b_channel_textmessage_delete`: Delete decentral chat messages. TeamSpeak 6 only. */
  ChannelTextMessageDelete: "b_channel_textmessage_delete",
  /** `i_client_private_textmessage_power`: Client private message power. */
  ClientPrivateTextMessagePower: "i_client_private_textmessage_power",
  /** `i_client_needed_private_textmessage_power`: Needed client private message power. */
  ClientNeededPrivateTextMessagePower: "i_client_needed_private_textmessage_power",
  /** `b_client_server_textmessage_send`: Send text messages to virtual server. */
  ClientServerTextMessageSend: "b_client_server_textmessage_send",
  /** `b_client_channel_textmessage_send`: Send text messages to channel. */
  ClientChannelTextMessageSend: "b_client_channel_textmessage_send",
  /** `b_client_offline_textmessage_send`: Send offline messages to clients. */
  ClientOfflineTextMessageSend: "b_client_offline_textmessage_send",
  /** `i_client_talk_power`: Client talk power. */
  ClientTalkPower: "i_client_talk_power",
  /** `i_client_needed_talk_power`: Needed client talk power. */
  ClientNeededTalkPower: "i_client_needed_talk_power",
  /** `i_client_poke_power`: Client poke power. */
  ClientPokePower: "i_client_poke_power",
  /** `i_client_needed_poke_power`: Needed client poke power. */
  ClientNeededPokePower: "i_client_needed_poke_power",
  /** `b_client_set_flag_talker`: Set the talker flag for clients and allow them to speak. */
  ClientSetFlagTalker: "b_client_set_flag_talker",
  /** `i_client_whisper_power`: Client whisper power. */
  ClientWhisperPower: "i_client_whisper_power",
  /** `i_client_needed_whisper_power`: Client needed whisper power. */
  ClientNeededWhisperPower: "i_client_needed_whisper_power",
  /** `b_client_modify_description`: Edit a clients description. */
  ClientModifyDescription: "b_client_modify_description",
  /** `b_client_modify_own_description`: Allow client to edit own description. */
  ClientModifyOwnDescription: "b_client_modify_own_description",
  /** `b_client_modify_dbproperties`: Edit a clients properties in the database. */
  ClientModifyDBProperties: "b_client_modify_dbproperties",
  /** `b_client_delete_dbproperties`: Delete a clients properties in the database. */
  ClientDeleteDBProperties: "b_client_delete_dbproperties",
  /** `b_client_create_modify_serverquery_login`: Create or modify own ServerQuery account. */
  ClientCreateModifyServerQueryLogin: "b_client_create_modify_serverquery_login",
  /** `b_ft_ignore_password`: Browse files without channel password. */
  FTIgnorePassword: "b_ft_ignore_password",
  /** `b_ft_transfer_list`: Retrieve list of running filetransfers. */
  FTTransferList: "b_ft_transfer_list",
  /** `i_ft_file_upload_power`: File upload power. */
  FTFileUploadPower: "i_ft_file_upload_power",
  /** `i_ft_needed_file_upload_power`: Needed file upload power. */
  FTNeededFileUploadPower: "i_ft_needed_file_upload_power",
  /** `i_ft_file_download_power`: File download power. */
  FTFileDownloadPower: "i_ft_file_download_power",
  /** `i_ft_needed_file_download_power`: Needed file download power. */
  FTNeededFileDownloadPower: "i_ft_needed_file_download_power",
  /** `i_ft_file_delete_power`: File delete power. */
  FTFileDeletePower: "i_ft_file_delete_power",
  /** `i_ft_needed_file_delete_power`: Needed file delete power. */
  FTNeededFileDeletePower: "i_ft_needed_file_delete_power",
  /** `i_ft_file_rename_power`: File rename power. */
  FTFileRenamePower: "i_ft_file_rename_power",
  /** `i_ft_needed_file_rename_power`: Needed file rename power. */
  FTNeededFileRenamePower: "i_ft_needed_file_rename_power",
  /** `i_ft_file_browse_power`: File browse power. */
  FTFileBrowsePower: "i_ft_file_browse_power",
  /** `i_ft_needed_file_browse_power`: Needed file browse power. */
  FTNeededFileBrowsePower: "i_ft_needed_file_browse_power",
  /** `i_ft_directory_create_power`: Create directory power. */
  FTDirectoryCreatePower: "i_ft_directory_create_power",
  /** `i_ft_needed_directory_create_power`: Needed create directory power. */
  FTNeededDirectoryCreatePower: "i_ft_needed_directory_create_power",
  /** `i_ft_quota_mb_download_per_client`: Download quota per client in MByte. */
  FTQuotaMBDownloadPerClient: "i_ft_quota_mb_download_per_client",
  /** `i_ft_quota_mb_upload_per_client`: Upload quota per client in MByte. */
  FTQuotaMBUploadPerClient: "i_ft_quota_mb_upload_per_client",
  /** `i_ft_storage_mb_per_client`: File Storage space per client in MByte. TeamSpeak 6 only. */
  FTStorageMBPerClient: "i_ft_storage_mb_per_client",
  /** `i_ft_max_file_size_mb`: Maximum file size of a single file this client can upload. TeamSpeak 6 only. */
  FTMaxFileSizeMB: "i_ft_max_file_size_mb",
  // The permission that sets the modify power needed to change each permission above, named NeededModifyPower followed by that permission's own name, in the order the server lists them.
  /** `i_needed_modify_power_serverinstance_help_view`: The power needed to modify `b_serverinstance_help_view`. */
  NeededModifyPowerServerInstanceHelpView: "i_needed_modify_power_serverinstance_help_view",
  /** `i_needed_modify_power_serverinstance_info_view`: The power needed to modify `b_serverinstance_info_view`. */
  NeededModifyPowerServerInstanceInfoView: "i_needed_modify_power_serverinstance_info_view",
  /** `i_needed_modify_power_serverinstance_virtualserver_list`: The power needed to modify `b_serverinstance_virtualserver_list`. */
  NeededModifyPowerServerInstanceVirtualServerList:
    "i_needed_modify_power_serverinstance_virtualserver_list",
  /** `i_needed_modify_power_serverinstance_binding_list`: The power needed to modify `b_serverinstance_binding_list`. */
  NeededModifyPowerServerInstanceBindingList: "i_needed_modify_power_serverinstance_binding_list",
  /** `i_needed_modify_power_serverinstance_permission_list`: The power needed to modify `b_serverinstance_permission_list`. */
  NeededModifyPowerServerInstancePermissionList:
    "i_needed_modify_power_serverinstance_permission_list",
  /** `i_needed_modify_power_serverinstance_permission_find`: The power needed to modify `b_serverinstance_permission_find`. */
  NeededModifyPowerServerInstancePermissionFind:
    "i_needed_modify_power_serverinstance_permission_find",
  /** `i_needed_modify_power_virtualserver_create`: The power needed to modify `b_virtualserver_create`. */
  NeededModifyPowerVirtualServerCreate: "i_needed_modify_power_virtualserver_create",
  /** `i_needed_modify_power_virtualserver_delete`: The power needed to modify `b_virtualserver_delete`. */
  NeededModifyPowerVirtualServerDelete: "i_needed_modify_power_virtualserver_delete",
  /** `i_needed_modify_power_virtualserver_start_any`: The power needed to modify `b_virtualserver_start_any`. */
  NeededModifyPowerVirtualServerStartAny: "i_needed_modify_power_virtualserver_start_any",
  /** `i_needed_modify_power_virtualserver_stop_any`: The power needed to modify `b_virtualserver_stop_any`. */
  NeededModifyPowerVirtualServerStopAny: "i_needed_modify_power_virtualserver_stop_any",
  /** `i_needed_modify_power_virtualserver_change_machine_id`: The power needed to modify `b_virtualserver_change_machine_id`. */
  NeededModifyPowerVirtualServerChangeMachineID:
    "i_needed_modify_power_virtualserver_change_machine_id",
  /** `i_needed_modify_power_virtualserver_change_template`: The power needed to modify `b_virtualserver_change_template`. */
  NeededModifyPowerVirtualServerChangeTemplate:
    "i_needed_modify_power_virtualserver_change_template",
  /** `i_needed_modify_power_serverquery_login`: The power needed to modify `b_serverquery_login`. */
  NeededModifyPowerServerQueryLogin: "i_needed_modify_power_serverquery_login",
  /** `i_needed_modify_power_serverquery_login_create`: The power needed to modify `b_serverquery_login_create`. */
  NeededModifyPowerServerQueryLoginCreate: "i_needed_modify_power_serverquery_login_create",
  /** `i_needed_modify_power_serverquery_login_delete`: The power needed to modify `b_serverquery_login_delete`. */
  NeededModifyPowerServerQueryLoginDelete: "i_needed_modify_power_serverquery_login_delete",
  /** `i_needed_modify_power_serverquery_login_list`: The power needed to modify `b_serverquery_login_list`. */
  NeededModifyPowerServerQueryLoginList: "i_needed_modify_power_serverquery_login_list",
  /** `i_needed_modify_power_serverinstance_textmessage_send`: The power needed to modify `b_serverinstance_textmessage_send`. */
  NeededModifyPowerServerInstanceTextMessageSend:
    "i_needed_modify_power_serverinstance_textmessage_send",
  /** `i_needed_modify_power_serverinstance_log_view`: The power needed to modify `b_serverinstance_log_view`. */
  NeededModifyPowerServerInstanceLogView: "i_needed_modify_power_serverinstance_log_view",
  /** `i_needed_modify_power_serverinstance_log_add`: The power needed to modify `b_serverinstance_log_add`. */
  NeededModifyPowerServerInstanceLogAdd: "i_needed_modify_power_serverinstance_log_add",
  /** `i_needed_modify_power_serverinstance_stop`: The power needed to modify `b_serverinstance_stop`. */
  NeededModifyPowerServerInstanceStop: "i_needed_modify_power_serverinstance_stop",
  /** `i_needed_modify_power_serverinstance_licensesign_message`: The power needed to modify `b_serverinstance_licensesign_message`. TeamSpeak 6 only. */
  NeededModifyPowerServerInstanceLicenseSignMessage:
    "i_needed_modify_power_serverinstance_licensesign_message",
  /** `i_needed_modify_power_serverinstance_modify_settings`: The power needed to modify `b_serverinstance_modify_settings`. */
  NeededModifyPowerServerInstanceModifySettings:
    "i_needed_modify_power_serverinstance_modify_settings",
  /** `i_needed_modify_power_serverinstance_modify_querygroup`: The power needed to modify `b_serverinstance_modify_querygroup`. */
  NeededModifyPowerServerInstanceModifyQueryGroup:
    "i_needed_modify_power_serverinstance_modify_querygroup",
  /** `i_needed_modify_power_serverinstance_modify_templates`: The power needed to modify `b_serverinstance_modify_templates`. */
  NeededModifyPowerServerInstanceModifyTemplates:
    "i_needed_modify_power_serverinstance_modify_templates",
  /** `i_needed_modify_power_virtualserver_select`: The power needed to modify `b_virtualserver_select`. */
  NeededModifyPowerVirtualServerSelect: "i_needed_modify_power_virtualserver_select",
  /** `i_needed_modify_power_virtualserver_info_view`: The power needed to modify `b_virtualserver_info_view`. */
  NeededModifyPowerVirtualServerInfoView: "i_needed_modify_power_virtualserver_info_view",
  /** `i_needed_modify_power_virtualserver_connectioninfo_view`: The power needed to modify `b_virtualserver_connectioninfo_view`. */
  NeededModifyPowerVirtualServerConnectionInfoView:
    "i_needed_modify_power_virtualserver_connectioninfo_view",
  /** `i_needed_modify_power_virtualserver_channel_list`: The power needed to modify `b_virtualserver_channel_list`. */
  NeededModifyPowerVirtualServerChannelList: "i_needed_modify_power_virtualserver_channel_list",
  /** `i_needed_modify_power_virtualserver_channel_search`: The power needed to modify `b_virtualserver_channel_search`. */
  NeededModifyPowerVirtualServerChannelSearch: "i_needed_modify_power_virtualserver_channel_search",
  /** `i_needed_modify_power_virtualserver_client_list`: The power needed to modify `b_virtualserver_client_list`. */
  NeededModifyPowerVirtualServerClientList: "i_needed_modify_power_virtualserver_client_list",
  /** `i_needed_modify_power_virtualserver_client_search`: The power needed to modify `b_virtualserver_client_search`. */
  NeededModifyPowerVirtualServerClientSearch: "i_needed_modify_power_virtualserver_client_search",
  /** `i_needed_modify_power_virtualserver_client_dblist`: The power needed to modify `b_virtualserver_client_dblist`. */
  NeededModifyPowerVirtualServerClientDBList: "i_needed_modify_power_virtualserver_client_dblist",
  /** `i_needed_modify_power_virtualserver_client_dbsearch`: The power needed to modify `b_virtualserver_client_dbsearch`. */
  NeededModifyPowerVirtualServerClientDBSearch:
    "i_needed_modify_power_virtualserver_client_dbsearch",
  /** `i_needed_modify_power_virtualserver_client_dbinfo`: The power needed to modify `b_virtualserver_client_dbinfo`. */
  NeededModifyPowerVirtualServerClientDBInfo: "i_needed_modify_power_virtualserver_client_dbinfo",
  /** `i_needed_modify_power_virtualserver_permission_find`: The power needed to modify `b_virtualserver_permission_find`. */
  NeededModifyPowerVirtualServerPermissionFind:
    "i_needed_modify_power_virtualserver_permission_find",
  /** `i_needed_modify_power_virtualserver_custom_search`: The power needed to modify `b_virtualserver_custom_search`. */
  NeededModifyPowerVirtualServerCustomSearch: "i_needed_modify_power_virtualserver_custom_search",
  /** `i_needed_modify_power_virtualserver_start`: The power needed to modify `b_virtualserver_start`. */
  NeededModifyPowerVirtualServerStart: "i_needed_modify_power_virtualserver_start",
  /** `i_needed_modify_power_virtualserver_stop`: The power needed to modify `b_virtualserver_stop`. */
  NeededModifyPowerVirtualServerStop: "i_needed_modify_power_virtualserver_stop",
  /** `i_needed_modify_power_virtualserver_token_list`: The power needed to modify `b_virtualserver_token_list`. */
  NeededModifyPowerVirtualServerTokenList: "i_needed_modify_power_virtualserver_token_list",
  /** `i_needed_modify_power_virtualserver_token_add`: The power needed to modify `b_virtualserver_token_add`. */
  NeededModifyPowerVirtualServerTokenAdd: "i_needed_modify_power_virtualserver_token_add",
  /** `i_needed_modify_power_virtualserver_token_use`: The power needed to modify `b_virtualserver_token_use`. */
  NeededModifyPowerVirtualServerTokenUse: "i_needed_modify_power_virtualserver_token_use",
  /** `i_needed_modify_power_virtualserver_token_delete`: The power needed to modify `b_virtualserver_token_delete`. */
  NeededModifyPowerVirtualServerTokenDelete: "i_needed_modify_power_virtualserver_token_delete",
  /** `i_needed_modify_power_virtualserver_apikey_add`: The power needed to modify `b_virtualserver_apikey_add`. */
  NeededModifyPowerVirtualServerAPIKeyAdd: "i_needed_modify_power_virtualserver_apikey_add",
  /** `i_needed_modify_power_virtualserver_apikey_manage`: The power needed to modify `b_virtualserver_apikey_manage`. */
  NeededModifyPowerVirtualServerAPIKeyManage: "i_needed_modify_power_virtualserver_apikey_manage",
  /** `i_needed_modify_power_virtualserver_log_view`: The power needed to modify `b_virtualserver_log_view`. */
  NeededModifyPowerVirtualServerLogView: "i_needed_modify_power_virtualserver_log_view",
  /** `i_needed_modify_power_virtualserver_log_add`: The power needed to modify `b_virtualserver_log_add`. */
  NeededModifyPowerVirtualServerLogAdd: "i_needed_modify_power_virtualserver_log_add",
  /** `i_needed_modify_power_virtualserver_join_ignore_password`: The power needed to modify `b_virtualserver_join_ignore_password`. */
  NeededModifyPowerVirtualServerJoinIgnorePassword:
    "i_needed_modify_power_virtualserver_join_ignore_password",
  /** `i_needed_modify_power_virtualserver_notify_register`: The power needed to modify `b_virtualserver_notify_register`. */
  NeededModifyPowerVirtualServerNotifyRegister:
    "i_needed_modify_power_virtualserver_notify_register",
  /** `i_needed_modify_power_virtualserver_notify_unregister`: The power needed to modify `b_virtualserver_notify_unregister`. */
  NeededModifyPowerVirtualServerNotifyUnregister:
    "i_needed_modify_power_virtualserver_notify_unregister",
  /** `i_needed_modify_power_virtualserver_snapshot_create`: The power needed to modify `b_virtualserver_snapshot_create`. */
  NeededModifyPowerVirtualServerSnapshotCreate:
    "i_needed_modify_power_virtualserver_snapshot_create",
  /** `i_needed_modify_power_virtualserver_snapshot_deploy`: The power needed to modify `b_virtualserver_snapshot_deploy`. */
  NeededModifyPowerVirtualServerSnapshotDeploy:
    "i_needed_modify_power_virtualserver_snapshot_deploy",
  /** `i_needed_modify_power_virtualserver_permission_reset`: The power needed to modify `b_virtualserver_permission_reset`. */
  NeededModifyPowerVirtualServerPermissionReset:
    "i_needed_modify_power_virtualserver_permission_reset",
  /** `i_needed_modify_power_virtualserver_canonical_name_manage`: The power needed to modify `b_virtualserver_canonical_name_manage`. TeamSpeak 6 only. */
  NeededModifyPowerVirtualServerCanonicalNameManage:
    "i_needed_modify_power_virtualserver_canonical_name_manage",
  /** `i_needed_modify_power_virtualserver_modify_name`: The power needed to modify `b_virtualserver_modify_name`. */
  NeededModifyPowerVirtualServerModifyName: "i_needed_modify_power_virtualserver_modify_name",
  /** `i_needed_modify_power_virtualserver_modify_welcomemessage`: The power needed to modify `b_virtualserver_modify_welcomemessage`. */
  NeededModifyPowerVirtualServerModifyWelcomeMessage:
    "i_needed_modify_power_virtualserver_modify_welcomemessage",
  /** `i_needed_modify_power_virtualserver_modify_maxclients`: The power needed to modify `b_virtualserver_modify_maxclients`. */
  NeededModifyPowerVirtualServerModifyMaxClients:
    "i_needed_modify_power_virtualserver_modify_maxclients",
  /** `i_needed_modify_power_virtualserver_modify_reserved_slots`: The power needed to modify `b_virtualserver_modify_reserved_slots`. */
  NeededModifyPowerVirtualServerModifyReservedSlots:
    "i_needed_modify_power_virtualserver_modify_reserved_slots",
  /** `i_needed_modify_power_virtualserver_modify_password`: The power needed to modify `b_virtualserver_modify_password`. */
  NeededModifyPowerVirtualServerModifyPassword:
    "i_needed_modify_power_virtualserver_modify_password",
  /** `i_needed_modify_power_virtualserver_modify_default_servergroup`: The power needed to modify `b_virtualserver_modify_default_servergroup`. */
  NeededModifyPowerVirtualServerModifyDefaultServerGroup:
    "i_needed_modify_power_virtualserver_modify_default_servergroup",
  /** `i_needed_modify_power_virtualserver_modify_default_channelgroup`: The power needed to modify `b_virtualserver_modify_default_channelgroup`. */
  NeededModifyPowerVirtualServerModifyDefaultChannelGroup:
    "i_needed_modify_power_virtualserver_modify_default_channelgroup",
  /** `i_needed_modify_power_virtualserver_modify_default_channeladmingroup`: The power needed to modify `b_virtualserver_modify_default_channeladmingroup`. */
  NeededModifyPowerVirtualServerModifyDefaultChannelAdminGroup:
    "i_needed_modify_power_virtualserver_modify_default_channeladmingroup",
  /** `i_needed_modify_power_virtualserver_modify_channel_forced_silence`: The power needed to modify `b_virtualserver_modify_channel_forced_silence`. */
  NeededModifyPowerVirtualServerModifyChannelForcedSilence:
    "i_needed_modify_power_virtualserver_modify_channel_forced_silence",
  /** `i_needed_modify_power_virtualserver_modify_complain`: The power needed to modify `b_virtualserver_modify_complain`. */
  NeededModifyPowerVirtualServerModifyComplain:
    "i_needed_modify_power_virtualserver_modify_complain",
  /** `i_needed_modify_power_virtualserver_modify_antiflood`: The power needed to modify `b_virtualserver_modify_antiflood`. */
  NeededModifyPowerVirtualServerModifyAntiflood:
    "i_needed_modify_power_virtualserver_modify_antiflood",
  /** `i_needed_modify_power_virtualserver_modify_ft_settings`: The power needed to modify `b_virtualserver_modify_ft_settings`. */
  NeededModifyPowerVirtualServerModifyFTSettings:
    "i_needed_modify_power_virtualserver_modify_ft_settings",
  /** `i_needed_modify_power_virtualserver_modify_ft_quotas`: The power needed to modify `b_virtualserver_modify_ft_quotas`. */
  NeededModifyPowerVirtualServerModifyFTQuotas:
    "i_needed_modify_power_virtualserver_modify_ft_quotas",
  /** `i_needed_modify_power_virtualserver_modify_hostmessage`: The power needed to modify `b_virtualserver_modify_hostmessage`. */
  NeededModifyPowerVirtualServerModifyHostMessage:
    "i_needed_modify_power_virtualserver_modify_hostmessage",
  /** `i_needed_modify_power_virtualserver_modify_hostbanner`: The power needed to modify `b_virtualserver_modify_hostbanner`. */
  NeededModifyPowerVirtualServerModifyHostBanner:
    "i_needed_modify_power_virtualserver_modify_hostbanner",
  /** `i_needed_modify_power_virtualserver_modify_hostbutton`: The power needed to modify `b_virtualserver_modify_hostbutton`. */
  NeededModifyPowerVirtualServerModifyHostButton:
    "i_needed_modify_power_virtualserver_modify_hostbutton",
  /** `i_needed_modify_power_virtualserver_modify_port`: The power needed to modify `b_virtualserver_modify_port`. */
  NeededModifyPowerVirtualServerModifyPort: "i_needed_modify_power_virtualserver_modify_port",
  /** `i_needed_modify_power_virtualserver_modify_autostart`: The power needed to modify `b_virtualserver_modify_autostart`. */
  NeededModifyPowerVirtualServerModifyAutoStart:
    "i_needed_modify_power_virtualserver_modify_autostart",
  /** `i_needed_modify_power_virtualserver_modify_needed_identity_security_level`: The power needed to modify `b_virtualserver_modify_needed_identity_security_level`. */
  NeededModifyPowerVirtualServerModifyNeededIdentitySecurityLevel:
    "i_needed_modify_power_virtualserver_modify_needed_identity_security_level",
  /** `i_needed_modify_power_virtualserver_modify_priority_speaker_dimm_modificator`: The power needed to modify `b_virtualserver_modify_priority_speaker_dimm_modificator`. */
  NeededModifyPowerVirtualServerModifyPrioritySpeakerDimmModificator:
    "i_needed_modify_power_virtualserver_modify_priority_speaker_dimm_modificator",
  /** `i_needed_modify_power_virtualserver_modify_log_settings`: The power needed to modify `b_virtualserver_modify_log_settings`. */
  NeededModifyPowerVirtualServerModifyLogSettings:
    "i_needed_modify_power_virtualserver_modify_log_settings",
  /** `i_needed_modify_power_virtualserver_modify_min_client_version`: The power needed to modify `b_virtualserver_modify_min_client_version`. */
  NeededModifyPowerVirtualServerModifyMinClientVersion:
    "i_needed_modify_power_virtualserver_modify_min_client_version",
  /** `i_needed_modify_power_virtualserver_modify_icon_id`: The power needed to modify `b_virtualserver_modify_icon_id`. */
  NeededModifyPowerVirtualServerModifyIconID: "i_needed_modify_power_virtualserver_modify_icon_id",
  /** `i_needed_modify_power_virtualserver_modify_weblist`: The power needed to modify `b_virtualserver_modify_weblist`. */
  NeededModifyPowerVirtualServerModifyWebList: "i_needed_modify_power_virtualserver_modify_weblist",
  /** `i_needed_modify_power_virtualserver_modify_codec_encryption_mode`: The power needed to modify `b_virtualserver_modify_codec_encryption_mode`. */
  NeededModifyPowerVirtualServerModifyCodecEncryptionMode:
    "i_needed_modify_power_virtualserver_modify_codec_encryption_mode",
  /** `i_needed_modify_power_virtualserver_modify_temporary_passwords`: The power needed to modify `b_virtualserver_modify_temporary_passwords`. */
  NeededModifyPowerVirtualServerModifyTemporaryPasswords:
    "i_needed_modify_power_virtualserver_modify_temporary_passwords",
  /** `i_needed_modify_power_virtualserver_modify_temporary_passwords_own`: The power needed to modify `b_virtualserver_modify_temporary_passwords_own`. */
  NeededModifyPowerVirtualServerModifyTemporaryPasswordsOwn:
    "i_needed_modify_power_virtualserver_modify_temporary_passwords_own",
  /** `i_needed_modify_power_virtualserver_modify_channel_temp_delete_delay_default`: The power needed to modify `b_virtualserver_modify_channel_temp_delete_delay_default`. */
  NeededModifyPowerVirtualServerModifyChannelTempDeleteDelayDefault:
    "i_needed_modify_power_virtualserver_modify_channel_temp_delete_delay_default",
  /** `i_needed_modify_power_virtualserver_modify_nickname`: The power needed to modify `b_virtualserver_modify_nickname`. */
  NeededModifyPowerVirtualServerModifyNickname:
    "i_needed_modify_power_virtualserver_modify_nickname",
  /** `i_needed_modify_power_virtualserver_modify_integrations`: The power needed to modify `b_virtualserver_modify_integrations`. */
  NeededModifyPowerVirtualServerModifyIntegrations:
    "i_needed_modify_power_virtualserver_modify_integrations",
  /** `i_needed_modify_power_virtualserver_modify_mytsid_connect`: The power needed to modify `b_virtualserver_modify_mytsid_connect`. TeamSpeak 6 only. */
  NeededModifyPowerVirtualServerModifyMyTSIDConnect:
    "i_needed_modify_power_virtualserver_modify_mytsid_connect",
  /** `i_needed_modify_power_channel_min_depth`: The power needed to modify `i_channel_min_depth`. */
  NeededModifyPowerChannelMinDepth: "i_needed_modify_power_channel_min_depth",
  /** `i_needed_modify_power_channel_max_depth`: The power needed to modify `i_channel_max_depth`. */
  NeededModifyPowerChannelMaxDepth: "i_needed_modify_power_channel_max_depth",
  /** `i_needed_modify_power_channel_group_inheritance_end`: The power needed to modify `b_channel_group_inheritance_end`. */
  NeededModifyPowerChannelGroupInheritanceEnd:
    "i_needed_modify_power_channel_group_inheritance_end",
  /** `i_needed_modify_power_channel_permission_modify_power`: The power needed to modify `i_channel_permission_modify_power`. */
  NeededModifyPowerChannelPermissionModifyPower:
    "i_needed_modify_power_channel_permission_modify_power",
  /** `i_needed_modify_power_channel_needed_permission_modify_power`: The power needed to modify `i_channel_needed_permission_modify_power`. */
  NeededModifyPowerChannelNeededPermissionModifyPower:
    "i_needed_modify_power_channel_needed_permission_modify_power",
  /** `i_needed_modify_power_channel_info_view`: The power needed to modify `b_channel_info_view`. */
  NeededModifyPowerChannelInfoView: "i_needed_modify_power_channel_info_view",
  /** `i_needed_modify_power_channel_create_child`: The power needed to modify `b_channel_create_child`. */
  NeededModifyPowerChannelCreateChild: "i_needed_modify_power_channel_create_child",
  /** `i_needed_modify_power_channel_create_permanent`: The power needed to modify `b_channel_create_permanent`. */
  NeededModifyPowerChannelCreatePermanent: "i_needed_modify_power_channel_create_permanent",
  /** `i_needed_modify_power_channel_create_semi_permanent`: The power needed to modify `b_channel_create_semi_permanent`. */
  NeededModifyPowerChannelCreateSemiPermanent:
    "i_needed_modify_power_channel_create_semi_permanent",
  /** `i_needed_modify_power_channel_create_temporary`: The power needed to modify `b_channel_create_temporary`. */
  NeededModifyPowerChannelCreateTemporary: "i_needed_modify_power_channel_create_temporary",
  /** `i_needed_modify_power_channel_create_with_topic`: The power needed to modify `b_channel_create_with_topic`. */
  NeededModifyPowerChannelCreateWithTopic: "i_needed_modify_power_channel_create_with_topic",
  /** `i_needed_modify_power_channel_create_with_description`: The power needed to modify `b_channel_create_with_description`. */
  NeededModifyPowerChannelCreateWithDescription:
    "i_needed_modify_power_channel_create_with_description",
  /** `i_needed_modify_power_channel_create_with_password`: The power needed to modify `b_channel_create_with_password`. */
  NeededModifyPowerChannelCreateWithPassword: "i_needed_modify_power_channel_create_with_password",
  /** `i_needed_modify_power_channel_create_with_banner`: The power needed to modify `b_channel_create_with_banner`. */
  NeededModifyPowerChannelCreateWithBanner: "i_needed_modify_power_channel_create_with_banner",
  /** `i_needed_modify_power_channel_create_modify_with_codec_opusvoice`: The power needed to modify `b_channel_create_modify_with_codec_opusvoice`. */
  NeededModifyPowerChannelCreateModifyWithCodecOpusVoice:
    "i_needed_modify_power_channel_create_modify_with_codec_opusvoice",
  /** `i_needed_modify_power_channel_create_modify_with_codec_opusmusic`: The power needed to modify `b_channel_create_modify_with_codec_opusmusic`. */
  NeededModifyPowerChannelCreateModifyWithCodecOpusMusic:
    "i_needed_modify_power_channel_create_modify_with_codec_opusmusic",
  /** `i_needed_modify_power_channel_create_modify_with_codec_maxquality`: The power needed to modify `i_channel_create_modify_with_codec_maxquality`. */
  NeededModifyPowerChannelCreateModifyWithCodecMaxQuality:
    "i_needed_modify_power_channel_create_modify_with_codec_maxquality",
  /** `i_needed_modify_power_channel_create_modify_with_codec_latency_factor_min`: The power needed to modify `i_channel_create_modify_with_codec_latency_factor_min`. */
  NeededModifyPowerChannelCreateModifyWithCodecLatencyFactorMin:
    "i_needed_modify_power_channel_create_modify_with_codec_latency_factor_min",
  /** `i_needed_modify_power_channel_create_with_maxclients`: The power needed to modify `b_channel_create_with_maxclients`. */
  NeededModifyPowerChannelCreateWithMaxClients:
    "i_needed_modify_power_channel_create_with_maxclients",
  /** `i_needed_modify_power_channel_create_with_maxfamilyclients`: The power needed to modify `b_channel_create_with_maxfamilyclients`. */
  NeededModifyPowerChannelCreateWithMaxFamilyClients:
    "i_needed_modify_power_channel_create_with_maxfamilyclients",
  /** `i_needed_modify_power_channel_create_with_sortorder`: The power needed to modify `b_channel_create_with_sortorder`. */
  NeededModifyPowerChannelCreateWithSortOrder:
    "i_needed_modify_power_channel_create_with_sortorder",
  /** `i_needed_modify_power_channel_create_with_default`: The power needed to modify `b_channel_create_with_default`. */
  NeededModifyPowerChannelCreateWithDefault: "i_needed_modify_power_channel_create_with_default",
  /** `i_needed_modify_power_channel_create_with_needed_talk_power`: The power needed to modify `b_channel_create_with_needed_talk_power`. */
  NeededModifyPowerChannelCreateWithNeededTalkPower:
    "i_needed_modify_power_channel_create_with_needed_talk_power",
  /** `i_needed_modify_power_channel_create_modify_with_force_password`: The power needed to modify `b_channel_create_modify_with_force_password`. */
  NeededModifyPowerChannelCreateModifyWithForcePassword:
    "i_needed_modify_power_channel_create_modify_with_force_password",
  /** `i_needed_modify_power_channel_create_modify_with_temp_delete_delay`: The power needed to modify `i_channel_create_modify_with_temp_delete_delay`. */
  NeededModifyPowerChannelCreateModifyWithTempDeleteDelay:
    "i_needed_modify_power_channel_create_modify_with_temp_delete_delay",
  /** `i_needed_modify_power_channel_modify_parent`: The power needed to modify `b_channel_modify_parent`. */
  NeededModifyPowerChannelModifyParent: "i_needed_modify_power_channel_modify_parent",
  /** `i_needed_modify_power_channel_modify_make_default`: The power needed to modify `b_channel_modify_make_default`. */
  NeededModifyPowerChannelModifyMakeDefault: "i_needed_modify_power_channel_modify_make_default",
  /** `i_needed_modify_power_channel_modify_make_permanent`: The power needed to modify `b_channel_modify_make_permanent`. */
  NeededModifyPowerChannelModifyMakePermanent:
    "i_needed_modify_power_channel_modify_make_permanent",
  /** `i_needed_modify_power_channel_modify_make_semi_permanent`: The power needed to modify `b_channel_modify_make_semi_permanent`. */
  NeededModifyPowerChannelModifyMakeSemiPermanent:
    "i_needed_modify_power_channel_modify_make_semi_permanent",
  /** `i_needed_modify_power_channel_modify_make_temporary`: The power needed to modify `b_channel_modify_make_temporary`. */
  NeededModifyPowerChannelModifyMakeTemporary:
    "i_needed_modify_power_channel_modify_make_temporary",
  /** `i_needed_modify_power_channel_modify_name`: The power needed to modify `b_channel_modify_name`. */
  NeededModifyPowerChannelModifyName: "i_needed_modify_power_channel_modify_name",
  /** `i_needed_modify_power_channel_modify_topic`: The power needed to modify `b_channel_modify_topic`. */
  NeededModifyPowerChannelModifyTopic: "i_needed_modify_power_channel_modify_topic",
  /** `i_needed_modify_power_channel_modify_description`: The power needed to modify `b_channel_modify_description`. */
  NeededModifyPowerChannelModifyDescription: "i_needed_modify_power_channel_modify_description",
  /** `i_needed_modify_power_channel_modify_password`: The power needed to modify `b_channel_modify_password`. */
  NeededModifyPowerChannelModifyPassword: "i_needed_modify_power_channel_modify_password",
  /** `i_needed_modify_power_channel_modify_banner`: The power needed to modify `b_channel_modify_banner`. */
  NeededModifyPowerChannelModifyBanner: "i_needed_modify_power_channel_modify_banner",
  /** `i_needed_modify_power_channel_modify_codec`: The power needed to modify `b_channel_modify_codec`. */
  NeededModifyPowerChannelModifyCodec: "i_needed_modify_power_channel_modify_codec",
  /** `i_needed_modify_power_channel_modify_codec_quality`: The power needed to modify `b_channel_modify_codec_quality`. */
  NeededModifyPowerChannelModifyCodecQuality: "i_needed_modify_power_channel_modify_codec_quality",
  /** `i_needed_modify_power_channel_modify_codec_latency_factor`: The power needed to modify `b_channel_modify_codec_latency_factor`. */
  NeededModifyPowerChannelModifyCodecLatencyFactor:
    "i_needed_modify_power_channel_modify_codec_latency_factor",
  /** `i_needed_modify_power_channel_modify_maxclients`: The power needed to modify `b_channel_modify_maxclients`. */
  NeededModifyPowerChannelModifyMaxClients: "i_needed_modify_power_channel_modify_maxclients",
  /** `i_needed_modify_power_channel_modify_maxfamilyclients`: The power needed to modify `b_channel_modify_maxfamilyclients`. */
  NeededModifyPowerChannelModifyMaxFamilyClients:
    "i_needed_modify_power_channel_modify_maxfamilyclients",
  /** `i_needed_modify_power_channel_modify_sortorder`: The power needed to modify `b_channel_modify_sortorder`. */
  NeededModifyPowerChannelModifySortOrder: "i_needed_modify_power_channel_modify_sortorder",
  /** `i_needed_modify_power_channel_modify_needed_talk_power`: The power needed to modify `b_channel_modify_needed_talk_power`. */
  NeededModifyPowerChannelModifyNeededTalkPower:
    "i_needed_modify_power_channel_modify_needed_talk_power",
  /** `i_needed_modify_power_channel_modify_power`: The power needed to modify `i_channel_modify_power`. */
  NeededModifyPowerChannelModifyPower: "i_needed_modify_power_channel_modify_power",
  /** `i_needed_modify_power_channel_needed_modify_power`: The power needed to modify `i_channel_needed_modify_power`. */
  NeededModifyPowerChannelNeededModifyPower: "i_needed_modify_power_channel_needed_modify_power",
  /** `i_needed_modify_power_channel_modify_make_codec_encrypted`: The power needed to modify `b_channel_modify_make_codec_encrypted`. */
  NeededModifyPowerChannelModifyMakeCodecEncrypted:
    "i_needed_modify_power_channel_modify_make_codec_encrypted",
  /** `i_needed_modify_power_channel_modify_temp_delete_delay`: The power needed to modify `b_channel_modify_temp_delete_delay`. */
  NeededModifyPowerChannelModifyTempDeleteDelay:
    "i_needed_modify_power_channel_modify_temp_delete_delay",
  /** `i_needed_modify_power_channel_modify_ft_quotas`: The power needed to modify `b_channel_modify_ft_quotas`. TeamSpeak 6 only. */
  NeededModifyPowerChannelModifyFTQuotas: "i_needed_modify_power_channel_modify_ft_quotas",
  /** `i_needed_modify_power_channel_delete_permanent`: The power needed to modify `b_channel_delete_permanent`. */
  NeededModifyPowerChannelDeletePermanent: "i_needed_modify_power_channel_delete_permanent",
  /** `i_needed_modify_power_channel_delete_semi_permanent`: The power needed to modify `b_channel_delete_semi_permanent`. */
  NeededModifyPowerChannelDeleteSemiPermanent:
    "i_needed_modify_power_channel_delete_semi_permanent",
  /** `i_needed_modify_power_channel_delete_temporary`: The power needed to modify `b_channel_delete_temporary`. */
  NeededModifyPowerChannelDeleteTemporary: "i_needed_modify_power_channel_delete_temporary",
  /** `i_needed_modify_power_channel_delete_flag_force`: The power needed to modify `b_channel_delete_flag_force`. */
  NeededModifyPowerChannelDeleteFlagForce: "i_needed_modify_power_channel_delete_flag_force",
  /** `i_needed_modify_power_channel_delete_power`: The power needed to modify `i_channel_delete_power`. */
  NeededModifyPowerChannelDeletePower: "i_needed_modify_power_channel_delete_power",
  /** `i_needed_modify_power_channel_needed_delete_power`: The power needed to modify `i_channel_needed_delete_power`. */
  NeededModifyPowerChannelNeededDeletePower: "i_needed_modify_power_channel_needed_delete_power",
  /** `i_needed_modify_power_channel_join_permanent`: The power needed to modify `b_channel_join_permanent`. */
  NeededModifyPowerChannelJoinPermanent: "i_needed_modify_power_channel_join_permanent",
  /** `i_needed_modify_power_channel_join_semi_permanent`: The power needed to modify `b_channel_join_semi_permanent`. */
  NeededModifyPowerChannelJoinSemiPermanent: "i_needed_modify_power_channel_join_semi_permanent",
  /** `i_needed_modify_power_channel_join_temporary`: The power needed to modify `b_channel_join_temporary`. */
  NeededModifyPowerChannelJoinTemporary: "i_needed_modify_power_channel_join_temporary",
  /** `i_needed_modify_power_channel_join_ignore_password`: The power needed to modify `b_channel_join_ignore_password`. */
  NeededModifyPowerChannelJoinIgnorePassword: "i_needed_modify_power_channel_join_ignore_password",
  /** `i_needed_modify_power_channel_join_ignore_maxclients`: The power needed to modify `b_channel_join_ignore_maxclients`. */
  NeededModifyPowerChannelJoinIgnoreMaxClients:
    "i_needed_modify_power_channel_join_ignore_maxclients",
  /** `i_needed_modify_power_channel_join_power`: The power needed to modify `i_channel_join_power`. */
  NeededModifyPowerChannelJoinPower: "i_needed_modify_power_channel_join_power",
  /** `i_needed_modify_power_channel_needed_join_power`: The power needed to modify `i_channel_needed_join_power`. */
  NeededModifyPowerChannelNeededJoinPower: "i_needed_modify_power_channel_needed_join_power",
  /** `i_needed_modify_power_channel_subscribe_power`: The power needed to modify `i_channel_subscribe_power`. */
  NeededModifyPowerChannelSubscribePower: "i_needed_modify_power_channel_subscribe_power",
  /** `i_needed_modify_power_channel_needed_subscribe_power`: The power needed to modify `i_channel_needed_subscribe_power`. */
  NeededModifyPowerChannelNeededSubscribePower:
    "i_needed_modify_power_channel_needed_subscribe_power",
  /** `i_needed_modify_power_channel_description_view_power`: The power needed to modify `i_channel_description_view_power`. */
  NeededModifyPowerChannelDescriptionViewPower:
    "i_needed_modify_power_channel_description_view_power",
  /** `i_needed_modify_power_channel_needed_description_view_power`: The power needed to modify `i_channel_needed_description_view_power`. */
  NeededModifyPowerChannelNeededDescriptionViewPower:
    "i_needed_modify_power_channel_needed_description_view_power",
  /** `i_needed_modify_power_icon_id`: The power needed to modify `i_icon_id`. */
  NeededModifyPowerIconID: "i_needed_modify_power_icon_id",
  /** `i_needed_modify_power_max_icon_filesize`: The power needed to modify `i_max_icon_filesize`. */
  NeededModifyPowerMaxIconFileSize: "i_needed_modify_power_max_icon_filesize",
  /** `i_needed_modify_power_icon_manage`: The power needed to modify `b_icon_manage`. */
  NeededModifyPowerIconManage: "i_needed_modify_power_icon_manage",
  /** `i_needed_modify_power_group_is_permanent`: The power needed to modify `b_group_is_permanent`. */
  NeededModifyPowerGroupIsPermanent: "i_needed_modify_power_group_is_permanent",
  /** `i_needed_modify_power_group_auto_update_type`: The power needed to modify `i_group_auto_update_type`. */
  NeededModifyPowerGroupAutoUpdateType: "i_needed_modify_power_group_auto_update_type",
  /** `i_needed_modify_power_group_auto_update_max_value`: The power needed to modify `i_group_auto_update_max_value`. */
  NeededModifyPowerGroupAutoUpdateMaxValue: "i_needed_modify_power_group_auto_update_max_value",
  /** `i_needed_modify_power_group_sort_id`: The power needed to modify `i_group_sort_id`. */
  NeededModifyPowerGroupSortID: "i_needed_modify_power_group_sort_id",
  /** `i_needed_modify_power_group_show_name_in_tree`: The power needed to modify `i_group_show_name_in_tree`. */
  NeededModifyPowerGroupShowNameInTree: "i_needed_modify_power_group_show_name_in_tree",
  /** `i_needed_modify_power_virtualserver_servergroup_list`: The power needed to modify `b_virtualserver_servergroup_list`. */
  NeededModifyPowerVirtualServerServerGroupList:
    "i_needed_modify_power_virtualserver_servergroup_list",
  /** `i_needed_modify_power_virtualserver_servergroup_permission_list`: The power needed to modify `b_virtualserver_servergroup_permission_list`. */
  NeededModifyPowerVirtualServerServerGroupPermissionList:
    "i_needed_modify_power_virtualserver_servergroup_permission_list",
  /** `i_needed_modify_power_virtualserver_servergroup_client_list`: The power needed to modify `b_virtualserver_servergroup_client_list`. */
  NeededModifyPowerVirtualServerServerGroupClientList:
    "i_needed_modify_power_virtualserver_servergroup_client_list",
  /** `i_needed_modify_power_virtualserver_channelgroup_list`: The power needed to modify `b_virtualserver_channelgroup_list`. */
  NeededModifyPowerVirtualServerChannelGroupList:
    "i_needed_modify_power_virtualserver_channelgroup_list",
  /** `i_needed_modify_power_virtualserver_channelgroup_permission_list`: The power needed to modify `b_virtualserver_channelgroup_permission_list`. */
  NeededModifyPowerVirtualServerChannelGroupPermissionList:
    "i_needed_modify_power_virtualserver_channelgroup_permission_list",
  /** `i_needed_modify_power_virtualserver_channelgroup_client_list`: The power needed to modify `b_virtualserver_channelgroup_client_list`. */
  NeededModifyPowerVirtualServerChannelGroupClientList:
    "i_needed_modify_power_virtualserver_channelgroup_client_list",
  /** `i_needed_modify_power_virtualserver_client_permission_list`: The power needed to modify `b_virtualserver_client_permission_list`. */
  NeededModifyPowerVirtualServerClientPermissionList:
    "i_needed_modify_power_virtualserver_client_permission_list",
  /** `i_needed_modify_power_virtualserver_channel_permission_list`: The power needed to modify `b_virtualserver_channel_permission_list`. */
  NeededModifyPowerVirtualServerChannelPermissionList:
    "i_needed_modify_power_virtualserver_channel_permission_list",
  /** `i_needed_modify_power_virtualserver_channelclient_permission_list`: The power needed to modify `b_virtualserver_channelclient_permission_list`. */
  NeededModifyPowerVirtualServerChannelClientPermissionList:
    "i_needed_modify_power_virtualserver_channelclient_permission_list",
  /** `i_needed_modify_power_virtualserver_servergroup_create`: The power needed to modify `b_virtualserver_servergroup_create`. */
  NeededModifyPowerVirtualServerServerGroupCreate:
    "i_needed_modify_power_virtualserver_servergroup_create",
  /** `i_needed_modify_power_virtualserver_channelgroup_create`: The power needed to modify `b_virtualserver_channelgroup_create`. */
  NeededModifyPowerVirtualServerChannelGroupCreate:
    "i_needed_modify_power_virtualserver_channelgroup_create",
  /** `i_needed_modify_power_group_modify_power`: The power needed to modify `i_group_modify_power`. */
  NeededModifyPowerGroupModifyPower: "i_needed_modify_power_group_modify_power",
  /** `i_needed_modify_power_group_needed_modify_power`: The power needed to modify `i_group_needed_modify_power`. */
  NeededModifyPowerGroupNeededModifyPower: "i_needed_modify_power_group_needed_modify_power",
  /** `i_needed_modify_power_group_member_add_power`: The power needed to modify `i_group_member_add_power`. */
  NeededModifyPowerGroupMemberAddPower: "i_needed_modify_power_group_member_add_power",
  /** `i_needed_modify_power_group_needed_member_add_power`: The power needed to modify `i_group_needed_member_add_power`. */
  NeededModifyPowerGroupNeededMemberAddPower: "i_needed_modify_power_group_needed_member_add_power",
  /** `i_needed_modify_power_group_member_remove_power`: The power needed to modify `i_group_member_remove_power`. */
  NeededModifyPowerGroupMemberRemovePower: "i_needed_modify_power_group_member_remove_power",
  /** `i_needed_modify_power_group_needed_member_remove_power`: The power needed to modify `i_group_needed_member_remove_power`. */
  NeededModifyPowerGroupNeededMemberRemovePower:
    "i_needed_modify_power_group_needed_member_remove_power",
  /** `i_needed_modify_power_permission_modify_power`: The power needed to modify `i_permission_modify_power`. */
  NeededModifyPowerPermissionModifyPower: "i_needed_modify_power_permission_modify_power",
  /** `i_needed_modify_power_permission_modify_power_ignore`: The power needed to modify `b_permission_modify_power_ignore`. */
  NeededModifyPowerPermissionModifyPowerIgnore:
    "i_needed_modify_power_permission_modify_power_ignore",
  /** `i_needed_modify_power_virtualserver_servergroup_delete`: The power needed to modify `b_virtualserver_servergroup_delete`. */
  NeededModifyPowerVirtualServerServerGroupDelete:
    "i_needed_modify_power_virtualserver_servergroup_delete",
  /** `i_needed_modify_power_virtualserver_channelgroup_delete`: The power needed to modify `b_virtualserver_channelgroup_delete`. */
  NeededModifyPowerVirtualServerChannelGroupDelete:
    "i_needed_modify_power_virtualserver_channelgroup_delete",
  /** `i_needed_modify_power_client_permission_modify_power`: The power needed to modify `i_client_permission_modify_power`. */
  NeededModifyPowerClientPermissionModifyPower:
    "i_needed_modify_power_client_permission_modify_power",
  /** `i_needed_modify_power_client_needed_permission_modify_power`: The power needed to modify `i_client_needed_permission_modify_power`. */
  NeededModifyPowerClientNeededPermissionModifyPower:
    "i_needed_modify_power_client_needed_permission_modify_power",
  /** `i_needed_modify_power_client_max_clones_uid`: The power needed to modify `i_client_max_clones_uid`. */
  NeededModifyPowerClientMaxClonesUID: "i_needed_modify_power_client_max_clones_uid",
  /** `i_needed_modify_power_client_max_idletime`: The power needed to modify `i_client_max_idletime`. */
  NeededModifyPowerClientMaxIdleTime: "i_needed_modify_power_client_max_idletime",
  /** `i_needed_modify_power_client_max_avatar_filesize`: The power needed to modify `i_client_max_avatar_filesize`. */
  NeededModifyPowerClientMaxAvatarFileSize: "i_needed_modify_power_client_max_avatar_filesize",
  /** `i_needed_modify_power_client_max_channel_subscriptions`: The power needed to modify `i_client_max_channel_subscriptions`. */
  NeededModifyPowerClientMaxChannelSubscriptions:
    "i_needed_modify_power_client_max_channel_subscriptions",
  /** `i_needed_modify_power_client_is_priority_speaker`: The power needed to modify `b_client_is_priority_speaker`. */
  NeededModifyPowerClientIsPrioritySpeaker: "i_needed_modify_power_client_is_priority_speaker",
  /** `i_needed_modify_power_client_skip_channelgroup_permissions`: The power needed to modify `b_client_skip_channelgroup_permissions`. */
  NeededModifyPowerClientSkipChannelGroupPermissions:
    "i_needed_modify_power_client_skip_channelgroup_permissions",
  /** `i_needed_modify_power_client_force_push_to_talk`: The power needed to modify `b_client_force_push_to_talk`. */
  NeededModifyPowerClientForcePushToTalk: "i_needed_modify_power_client_force_push_to_talk",
  /** `i_needed_modify_power_client_ignore_bans`: The power needed to modify `b_client_ignore_bans`. */
  NeededModifyPowerClientIgnoreBans: "i_needed_modify_power_client_ignore_bans",
  /** `i_needed_modify_power_client_ignore_antiflood`: The power needed to modify `b_client_ignore_antiflood`. */
  NeededModifyPowerClientIgnoreAntiflood: "i_needed_modify_power_client_ignore_antiflood",
  /** `i_needed_modify_power_client_use_reserved_slot`: The power needed to modify `b_client_use_reserved_slot`. */
  NeededModifyPowerClientUseReservedSlot: "i_needed_modify_power_client_use_reserved_slot",
  /** `i_needed_modify_power_client_use_channel_commander`: The power needed to modify `b_client_use_channel_commander`. */
  NeededModifyPowerClientUseChannelCommander: "i_needed_modify_power_client_use_channel_commander",
  /** `i_needed_modify_power_client_request_talker`: The power needed to modify `b_client_request_talker`. */
  NeededModifyPowerClientRequestTalker: "i_needed_modify_power_client_request_talker",
  /** `i_needed_modify_power_client_avatar_delete_other`: The power needed to modify `b_client_avatar_delete_other`. */
  NeededModifyPowerClientAvatarDeleteOther: "i_needed_modify_power_client_avatar_delete_other",
  /** `i_needed_modify_power_client_is_sticky`: The power needed to modify `b_client_is_sticky`. */
  NeededModifyPowerClientIsSticky: "i_needed_modify_power_client_is_sticky",
  /** `i_needed_modify_power_client_ignore_sticky`: The power needed to modify `b_client_ignore_sticky`. */
  NeededModifyPowerClientIgnoreSticky: "i_needed_modify_power_client_ignore_sticky",
  /** `i_needed_modify_power_client_info_view`: The power needed to modify `b_client_info_view`. */
  NeededModifyPowerClientInfoView: "i_needed_modify_power_client_info_view",
  /** `i_needed_modify_power_client_permissionoverview_view`: The power needed to modify `b_client_permissionoverview_view`. */
  NeededModifyPowerClientPermissionOverviewView:
    "i_needed_modify_power_client_permissionoverview_view",
  /** `i_needed_modify_power_client_permissionoverview_own`: The power needed to modify `b_client_permissionoverview_own`. */
  NeededModifyPowerClientPermissionOverviewOwn:
    "i_needed_modify_power_client_permissionoverview_own",
  /** `i_needed_modify_power_client_remoteaddress_view`: The power needed to modify `b_client_remoteaddress_view`. */
  NeededModifyPowerClientRemoteAddressView: "i_needed_modify_power_client_remoteaddress_view",
  /** `i_needed_modify_power_client_serverquery_view_power`: The power needed to modify `i_client_serverquery_view_power`. */
  NeededModifyPowerClientServerQueryViewPower:
    "i_needed_modify_power_client_serverquery_view_power",
  /** `i_needed_modify_power_client_needed_serverquery_view_power`: The power needed to modify `i_client_needed_serverquery_view_power`. */
  NeededModifyPowerClientNeededServerQueryViewPower:
    "i_needed_modify_power_client_needed_serverquery_view_power",
  /** `i_needed_modify_power_client_custom_info_view`: The power needed to modify `b_client_custom_info_view`. */
  NeededModifyPowerClientCustomInfoView: "i_needed_modify_power_client_custom_info_view",
  /** `i_needed_modify_power_client_kick_from_server_power`: The power needed to modify `i_client_kick_from_server_power`. */
  NeededModifyPowerClientKickFromServerPower: "i_needed_modify_power_client_kick_from_server_power",
  /** `i_needed_modify_power_client_needed_kick_from_server_power`: The power needed to modify `i_client_needed_kick_from_server_power`. */
  NeededModifyPowerClientNeededKickFromServerPower:
    "i_needed_modify_power_client_needed_kick_from_server_power",
  /** `i_needed_modify_power_client_kick_from_channel_power`: The power needed to modify `i_client_kick_from_channel_power`. */
  NeededModifyPowerClientKickFromChannelPower:
    "i_needed_modify_power_client_kick_from_channel_power",
  /** `i_needed_modify_power_client_needed_kick_from_channel_power`: The power needed to modify `i_client_needed_kick_from_channel_power`. */
  NeededModifyPowerClientNeededKickFromChannelPower:
    "i_needed_modify_power_client_needed_kick_from_channel_power",
  /** `i_needed_modify_power_client_ban_power`: The power needed to modify `i_client_ban_power`. */
  NeededModifyPowerClientBanPower: "i_needed_modify_power_client_ban_power",
  /** `i_needed_modify_power_client_needed_ban_power`: The power needed to modify `i_client_needed_ban_power`. */
  NeededModifyPowerClientNeededBanPower: "i_needed_modify_power_client_needed_ban_power",
  /** `i_needed_modify_power_client_move_power`: The power needed to modify `i_client_move_power`. */
  NeededModifyPowerClientMovePower: "i_needed_modify_power_client_move_power",
  /** `i_needed_modify_power_client_needed_move_power`: The power needed to modify `i_client_needed_move_power`. */
  NeededModifyPowerClientNeededMovePower: "i_needed_modify_power_client_needed_move_power",
  /** `i_needed_modify_power_client_complain_power`: The power needed to modify `i_client_complain_power`. */
  NeededModifyPowerClientComplainPower: "i_needed_modify_power_client_complain_power",
  /** `i_needed_modify_power_client_needed_complain_power`: The power needed to modify `i_client_needed_complain_power`. */
  NeededModifyPowerClientNeededComplainPower: "i_needed_modify_power_client_needed_complain_power",
  /** `i_needed_modify_power_client_complain_list`: The power needed to modify `b_client_complain_list`. */
  NeededModifyPowerClientComplainList: "i_needed_modify_power_client_complain_list",
  /** `i_needed_modify_power_client_complain_delete_own`: The power needed to modify `b_client_complain_delete_own`. */
  NeededModifyPowerClientComplainDeleteOwn: "i_needed_modify_power_client_complain_delete_own",
  /** `i_needed_modify_power_client_complain_delete`: The power needed to modify `b_client_complain_delete`. */
  NeededModifyPowerClientComplainDelete: "i_needed_modify_power_client_complain_delete",
  /** `i_needed_modify_power_client_ban_list`: The power needed to modify `b_client_ban_list`. */
  NeededModifyPowerClientBanList: "i_needed_modify_power_client_ban_list",
  /** `i_needed_modify_power_client_ban_create`: The power needed to modify `b_client_ban_create`. */
  NeededModifyPowerClientBanCreate: "i_needed_modify_power_client_ban_create",
  /** `i_needed_modify_power_client_ban_delete_own`: The power needed to modify `b_client_ban_delete_own`. */
  NeededModifyPowerClientBanDeleteOwn: "i_needed_modify_power_client_ban_delete_own",
  /** `i_needed_modify_power_client_ban_delete`: The power needed to modify `b_client_ban_delete`. */
  NeededModifyPowerClientBanDelete: "i_needed_modify_power_client_ban_delete",
  /** `i_needed_modify_power_client_ban_max_bantime`: The power needed to modify `i_client_ban_max_bantime`. */
  NeededModifyPowerClientBanMaxBanTime: "i_needed_modify_power_client_ban_max_bantime",
  /** `i_needed_modify_power_channel_textmessage_delete`: The power needed to modify `b_channel_textmessage_delete`. TeamSpeak 6 only. */
  NeededModifyPowerChannelTextMessageDelete: "i_needed_modify_power_channel_textmessage_delete",
  /** `i_needed_modify_power_client_private_textmessage_power`: The power needed to modify `i_client_private_textmessage_power`. */
  NeededModifyPowerClientPrivateTextMessagePower:
    "i_needed_modify_power_client_private_textmessage_power",
  /** `i_needed_modify_power_client_needed_private_textmessage_power`: The power needed to modify `i_client_needed_private_textmessage_power`. */
  NeededModifyPowerClientNeededPrivateTextMessagePower:
    "i_needed_modify_power_client_needed_private_textmessage_power",
  /** `i_needed_modify_power_client_server_textmessage_send`: The power needed to modify `b_client_server_textmessage_send`. */
  NeededModifyPowerClientServerTextMessageSend:
    "i_needed_modify_power_client_server_textmessage_send",
  /** `i_needed_modify_power_client_channel_textmessage_send`: The power needed to modify `b_client_channel_textmessage_send`. */
  NeededModifyPowerClientChannelTextMessageSend:
    "i_needed_modify_power_client_channel_textmessage_send",
  /** `i_needed_modify_power_client_offline_textmessage_send`: The power needed to modify `b_client_offline_textmessage_send`. */
  NeededModifyPowerClientOfflineTextMessageSend:
    "i_needed_modify_power_client_offline_textmessage_send",
  /** `i_needed_modify_power_client_talk_power`: The power needed to modify `i_client_talk_power`. */
  NeededModifyPowerClientTalkPower: "i_needed_modify_power_client_talk_power",
  /** `i_needed_modify_power_client_needed_talk_power`: The power needed to modify `i_client_needed_talk_power`. */
  NeededModifyPowerClientNeededTalkPower: "i_needed_modify_power_client_needed_talk_power",
  /** `i_needed_modify_power_client_poke_power`: The power needed to modify `i_client_poke_power`. */
  NeededModifyPowerClientPokePower: "i_needed_modify_power_client_poke_power",
  /** `i_needed_modify_power_client_needed_poke_power`: The power needed to modify `i_client_needed_poke_power`. */
  NeededModifyPowerClientNeededPokePower: "i_needed_modify_power_client_needed_poke_power",
  /** `i_needed_modify_power_client_set_flag_talker`: The power needed to modify `b_client_set_flag_talker`. */
  NeededModifyPowerClientSetFlagTalker: "i_needed_modify_power_client_set_flag_talker",
  /** `i_needed_modify_power_client_whisper_power`: The power needed to modify `i_client_whisper_power`. */
  NeededModifyPowerClientWhisperPower: "i_needed_modify_power_client_whisper_power",
  /** `i_needed_modify_power_client_needed_whisper_power`: The power needed to modify `i_client_needed_whisper_power`. */
  NeededModifyPowerClientNeededWhisperPower: "i_needed_modify_power_client_needed_whisper_power",
  /** `i_needed_modify_power_client_modify_description`: The power needed to modify `b_client_modify_description`. */
  NeededModifyPowerClientModifyDescription: "i_needed_modify_power_client_modify_description",
  /** `i_needed_modify_power_client_modify_own_description`: The power needed to modify `b_client_modify_own_description`. */
  NeededModifyPowerClientModifyOwnDescription:
    "i_needed_modify_power_client_modify_own_description",
  /** `i_needed_modify_power_client_modify_dbproperties`: The power needed to modify `b_client_modify_dbproperties`. */
  NeededModifyPowerClientModifyDBProperties: "i_needed_modify_power_client_modify_dbproperties",
  /** `i_needed_modify_power_client_delete_dbproperties`: The power needed to modify `b_client_delete_dbproperties`. */
  NeededModifyPowerClientDeleteDBProperties: "i_needed_modify_power_client_delete_dbproperties",
  /** `i_needed_modify_power_client_create_modify_serverquery_login`: The power needed to modify `b_client_create_modify_serverquery_login`. */
  NeededModifyPowerClientCreateModifyServerQueryLogin:
    "i_needed_modify_power_client_create_modify_serverquery_login",
  /** `i_needed_modify_power_ft_ignore_password`: The power needed to modify `b_ft_ignore_password`. */
  NeededModifyPowerFTIgnorePassword: "i_needed_modify_power_ft_ignore_password",
  /** `i_needed_modify_power_ft_transfer_list`: The power needed to modify `b_ft_transfer_list`. */
  NeededModifyPowerFTTransferList: "i_needed_modify_power_ft_transfer_list",
  /** `i_needed_modify_power_ft_file_upload_power`: The power needed to modify `i_ft_file_upload_power`. */
  NeededModifyPowerFTFileUploadPower: "i_needed_modify_power_ft_file_upload_power",
  /** `i_needed_modify_power_ft_needed_file_upload_power`: The power needed to modify `i_ft_needed_file_upload_power`. */
  NeededModifyPowerFTNeededFileUploadPower: "i_needed_modify_power_ft_needed_file_upload_power",
  /** `i_needed_modify_power_ft_file_download_power`: The power needed to modify `i_ft_file_download_power`. */
  NeededModifyPowerFTFileDownloadPower: "i_needed_modify_power_ft_file_download_power",
  /** `i_needed_modify_power_ft_needed_file_download_power`: The power needed to modify `i_ft_needed_file_download_power`. */
  NeededModifyPowerFTNeededFileDownloadPower: "i_needed_modify_power_ft_needed_file_download_power",
  /** `i_needed_modify_power_ft_file_delete_power`: The power needed to modify `i_ft_file_delete_power`. */
  NeededModifyPowerFTFileDeletePower: "i_needed_modify_power_ft_file_delete_power",
  /** `i_needed_modify_power_ft_needed_file_delete_power`: The power needed to modify `i_ft_needed_file_delete_power`. */
  NeededModifyPowerFTNeededFileDeletePower: "i_needed_modify_power_ft_needed_file_delete_power",
  /** `i_needed_modify_power_ft_file_rename_power`: The power needed to modify `i_ft_file_rename_power`. */
  NeededModifyPowerFTFileRenamePower: "i_needed_modify_power_ft_file_rename_power",
  /** `i_needed_modify_power_ft_needed_file_rename_power`: The power needed to modify `i_ft_needed_file_rename_power`. */
  NeededModifyPowerFTNeededFileRenamePower: "i_needed_modify_power_ft_needed_file_rename_power",
  /** `i_needed_modify_power_ft_file_browse_power`: The power needed to modify `i_ft_file_browse_power`. */
  NeededModifyPowerFTFileBrowsePower: "i_needed_modify_power_ft_file_browse_power",
  /** `i_needed_modify_power_ft_needed_file_browse_power`: The power needed to modify `i_ft_needed_file_browse_power`. */
  NeededModifyPowerFTNeededFileBrowsePower: "i_needed_modify_power_ft_needed_file_browse_power",
  /** `i_needed_modify_power_ft_directory_create_power`: The power needed to modify `i_ft_directory_create_power`. */
  NeededModifyPowerFTDirectoryCreatePower: "i_needed_modify_power_ft_directory_create_power",
  /** `i_needed_modify_power_ft_needed_directory_create_power`: The power needed to modify `i_ft_needed_directory_create_power`. */
  NeededModifyPowerFTNeededDirectoryCreatePower:
    "i_needed_modify_power_ft_needed_directory_create_power",
  /** `i_needed_modify_power_ft_quota_mb_download_per_client`: The power needed to modify `i_ft_quota_mb_download_per_client`. */
  NeededModifyPowerFTQuotaMBDownloadPerClient:
    "i_needed_modify_power_ft_quota_mb_download_per_client",
  /** `i_needed_modify_power_ft_quota_mb_upload_per_client`: The power needed to modify `i_ft_quota_mb_upload_per_client`. */
  NeededModifyPowerFTQuotaMBUploadPerClient: "i_needed_modify_power_ft_quota_mb_upload_per_client",
  /** `i_needed_modify_power_ft_storage_mb_per_client`: The power needed to modify `i_ft_storage_mb_per_client`. TeamSpeak 6 only. */
  NeededModifyPowerFTStorageMBPerClient: "i_needed_modify_power_ft_storage_mb_per_client",
  /** `i_needed_modify_power_ft_max_file_size_mb`: The power needed to modify `i_ft_max_file_size_mb`. TeamSpeak 6 only. */
  NeededModifyPowerFTMaxFileSizeMB: "i_needed_modify_power_ft_max_file_size_mb",
} as const;

/** The permission names; see {@link PermissionName}'s entries for what each allows. */
export const PermissionName: typeof permissionNameValues =
  /* @__PURE__ */ Object.freeze(permissionNameValues);

/** A permission name a TeamSpeak 3.13 or 6 server knows. */
export type PermissionName = (typeof PermissionName)[keyof typeof PermissionName];
