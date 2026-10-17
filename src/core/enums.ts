/**
 * Enumerations the server reports and accepts as small integers.
 *
 * Each is an object of named values plus a type of the same name, the way
 * `Reason` is: the object names the values (`GroupType.Regular`), the type
 * restricts a parameter to them.
 *
 * Parameters take the type; parsed results carry a plain `number`, since a
 * server may send a value newer than this table — compare it against the
 * names (`group.type === GroupType.Query`).
 *
 * Every table, and `ErrorCode` and `Reason` with them, may gain members in a
 * minor release: a `switch` over one needs a default case.
 */

/** The values of the table below, before freezing. */
const groupTypeValues = {
  /**
   * A template: the server copies it to create the groups of a new virtual
   * server, and no client can be a member.
   */
  Template: 0,
  /** An ordinary group that voice clients join. */
  Regular: 1,
  /** A group for ServerQuery clients. */
  Query: 2,
} as const;
/** What kind of group a server or channel group is (`type`). */
export const GroupType: typeof groupTypeValues = /* @__PURE__ */ Object.freeze(groupTypeValues);

/** A group type. */
export type GroupType = (typeof GroupType)[keyof typeof GroupType];

/** The values of the table below, before freezing. */
const groupNameModeValues = {
  /** No group name is shown. */
  Hidden: 0,
  /** The group name is shown before the nickname. */
  Before: 1,
  /** The group name is shown after the nickname. */
  After: 2,
} as const;
/** Where a group's name is shown beside a member's nickname (`namemode`). */
export const GroupNameMode: typeof groupNameModeValues =
  /* @__PURE__ */ Object.freeze(groupNameModeValues);

/** A group name mode. */
export type GroupNameMode = (typeof GroupNameMode)[keyof typeof GroupNameMode];

/** The values of the table below, before freezing. */
const hostMessageModeValues = {
  /** Show nothing. */
  None: 0,
  /** Show the message in the log. */
  Log: 1,
  /** Show the message in a modal dialog. */
  Modal: 2,
  /** Show the message in a modal dialog, then disconnect. */
  ModalQuit: 3,
} as const;
/** How a server's host message is to be shown (`virtualserver_hostmessage_mode`). */
export const HostMessageMode: typeof hostMessageModeValues =
  /* @__PURE__ */ Object.freeze(hostMessageModeValues);

/** A host message mode. */
export type HostMessageMode = (typeof HostMessageMode)[keyof typeof HostMessageMode];

/** The values of the table below, before freezing. */
const privilegeKeyTypeValues = {
  /** The key grants a server group. */
  ServerGroup: 0,
  /** The key grants a channel group in one channel. */
  ChannelGroup: 1,
} as const;
/** Which kind of group a privilege key grants (`token_type`). */
export const PrivilegeKeyType: typeof privilegeKeyTypeValues =
  /* @__PURE__ */ Object.freeze(privilegeKeyTypeValues);

/** A privilege key type. */
export type PrivilegeKeyType = (typeof PrivilegeKeyType)[keyof typeof PrivilegeKeyType];

/** The values of the table below, before freezing. */
const apiKeyScopeValues = {
  /** Read-only access to the query API. */
  Read: "read",
  /** Read and change what a query client may change. */
  Write: "write",
  /** Everything the owner may do, including managing API keys. */
  Manage: "manage",
} as const;
/** What an API key may do (`scope`). */
export const APIKeyScope: typeof apiKeyScopeValues =
  /* @__PURE__ */ Object.freeze(apiKeyScopeValues);

/** An API key scope. */
export type APIKeyScope = (typeof APIKeyScope)[keyof typeof APIKeyScope];

/** The values of the table below, before freezing. */
const groupAutoUpdateTypeValues = {
  /** The channel guest groups. */
  ChannelGuest: 10,
  /** The server guest groups. */
  ServerGuest: 15,
  /** The query guest groups. */
  QueryGuest: 20,
  /** The channel voice groups. */
  ChannelVoice: 25,
  /** The server normal groups. */
  ServerNormal: 30,
  /** The channel operator groups. */
  ChannelOperator: 35,
  /** The channel admin groups. */
  ChannelAdmin: 40,
  /** The server admin groups. */
  ServerAdmin: 45,
  /** The query admin groups. */
  QueryAdmin: 50,
} as const;
/**
 * Which regular groups a permission change reaches on every virtual server:
 * the groups whose `i_group_auto_update_type` permission has this value
 * (`sgtype`).
 */
export const GroupAutoUpdateType: typeof groupAutoUpdateTypeValues =
  /* @__PURE__ */ Object.freeze(groupAutoUpdateTypeValues);

/** A group auto update type. */
export type GroupAutoUpdateType = (typeof GroupAutoUpdateType)[keyof typeof GroupAutoUpdateType];

/** The values of the table below, before freezing. */
const clientTypeValues = {
  /** A voice client, such as the TeamSpeak application or this SDK's client. */
  Voice: 0,
  /** A ServerQuery client. */
  Query: 1,
} as const;
/** What kind of connection a client is (`client_type`). */
export const ClientType: typeof clientTypeValues = /* @__PURE__ */ Object.freeze(clientTypeValues);

/** A client type. */
export type ClientType = (typeof ClientType)[keyof typeof ClientType];

/** The values of the table below, before freezing. */
const codecValues = {
  /** Speex at 8 kHz. Current clients no longer play it. */
  SpeexNarrowband: 0,
  /** Speex at 16 kHz. Current clients no longer play it. */
  SpeexWideband: 1,
  /** Speex at 32 kHz. Current clients no longer play it. */
  SpeexUltraWideband: 2,
  /** CELT at 48 kHz. Current clients no longer play it. */
  CELTMono: 3,
  /** Opus tuned for speech, mono. */
  OpusVoice: 4,
  /** Opus tuned for music, stereo. */
  OpusMusic: 5,
} as const;
/** A voice codec: the one a channel uses (`channel_codec`). */
export const Codec: typeof codecValues = /* @__PURE__ */ Object.freeze(codecValues);

/** A voice codec. */
export type Codec = (typeof Codec)[keyof typeof Codec];

/** The values of the table below, before freezing. */
const permissionTargetValues = {
  /** A server group. */
  ServerGroup: 0,
  /** A client, server-wide. */
  Client: 1,
  /** A channel. */
  Channel: 2,
  /** A channel group, in one channel. */
  ChannelGroup: 3,
  /** A client within one channel. */
  ChannelClient: 4,
} as const;
/** What a permission is set on, as `permfind` and `permoverview` report it (`t`). */
export const PermissionTarget: typeof permissionTargetValues =
  /* @__PURE__ */ Object.freeze(permissionTargetValues);

/** A permission target. */
export type PermissionTarget = (typeof PermissionTarget)[keyof typeof PermissionTarget];

/** The values of the table below, before freezing. */
const textMessageTargetValues = {
  /** A private message to one client. */
  Client: 1,
  /** A message to the sender's current channel. */
  Channel: 2,
  /** A message to everyone on the virtual server. */
  Server: 3,
} as const;
/** Where a text message goes (`targetmode`), as text message events report it. */
export const TextMessageTarget: typeof textMessageTargetValues =
  /* @__PURE__ */ Object.freeze(textMessageTargetValues);

/** A text message target. */
export type TextMessageTarget = (typeof TextMessageTarget)[keyof typeof TextMessageTarget];

/** The values of the table below, before freezing. */
const logLevelValues = {
  /** An error. */
  Error: 1,
  /** A warning. */
  Warning: 2,
  /** Debugging detail. */
  Debug: 3,
  /** Routine information. */
  Info: 4,
} as const;
/** A server log severity, matching the server's own levels (`loglevel`). */
export const LogLevel: typeof logLevelValues = /* @__PURE__ */ Object.freeze(logLevelValues);

/** A log level. */
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
