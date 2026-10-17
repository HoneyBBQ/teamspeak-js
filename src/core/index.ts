/**
 * What every TeamSpeak connection shares: the command language, ids, errors,
 * and the typed commands that run on any connection able to execute a command.
 *
 * The voice client is in `@honeybbq/teamspeak/client`.
 *
 * @module @honeybbq/teamspeak
 */

// Escaping, for a raw line sent with a client's `exec`.
export { escape, unescape } from "./command/command.js";

// Requests and the connections that execute them.
export type {
  CommandExecutor,
  CommandOptions,
  CommandRequest,
  ParamValue,
} from "./command/request.js";

// Branded ids: a ChannelID cannot be passed where a ClientID is meant.
export {
  asBanID,
  asChannelID,
  asClientFileTransferID,
  asMessageID,
  asServerFileTransferID,
  asServerID,
  asChannelGroupID,
  asClientDBID,
  asClientID,
  asIconID,
  asPermissionID,
  asServerGroupID,
  asUID,
  asChannelUID,
} from "./command/ids.js";
export type {
  BanID,
  ClientFileTransferID,
  MessageID,
  ServerFileTransferID,
  ServerID,
  ChannelGroupID,
  ChannelID,
  ClientDBID,
  ClientID,
  IconID,
  PermissionID,
  ServerGroupID,
  UID,
  ChannelUID,
} from "./command/ids.js";

export {
  TeamspeakError,
  ServerError,
  CommandTimeoutError,
  NotConnectedError,
  NoDataError,
  AlreadyConnectedError,
} from "./errors.js";
export { ErrorCode } from "./errorcode.js";
export { Reason } from "./reason.js";

// Small-integer enumerations, as named values and types.
export {
  ClientType,
  Codec,
  GroupNameMode,
  GroupType,
  HostMessageMode,
  LogLevel,
  PermissionTarget,
  TextMessageTarget,
  PrivilegeKeyType,
} from "./enums.js";

// Permissions, by id or by name.
export { permissionByID, permissionByName } from "./permission.js";
export { PermissionName } from "./permission-name.js";
export { CommandName } from "./command-name.js";
export { NotificationName } from "./notification-name.js";
export { PropertyName } from "./property-name.js";
export type { Permission } from "./permission.js";

export { noopLogger, consoleLogger, ClientStatus } from "./types.js";
export type {
  ClientVersion,
  Listener,
  ServerFamily,
  Unsubscribe,
  CommandMiddleware,
  FileDownloadInfo,
  FileUploadInfo,
  Logger,
} from "./types.js";

// The events a server sends, shared by every client.
export type {
  TextMessageEvent,
  ClientMovedEvent,
  ClientLeaveEvent,
  KickedEvent,
  ClientEnterEvent,
  PokeEvent,
  VoiceDataEvent,
  NotificationEvent,
  ConnectedEvent,
  DisconnectedEvent,
  ServerEventMap,
  SessionEventMap,
} from "./events.js";

// Reconnection policy, whose retry decision each client supplies.
export { backoffDelay, defaultBackoffPolicy } from "./reconnect.js";
export type { BackoffPolicy, ReconnectOptions } from "./reconnect.js";

// Typed commands, one module per area of the protocol.
export * from "./api/channels.js";
export * from "./api/clients.js";
export * from "./api/server.js";
export * from "./api/groups.js";
export * from "./api/moderation.js";
export * from "./api/files.js";
export { applyChannelChanges } from "./api/command.js";
export type { Channel, ChannelChanges, PagingOptions, PermissionEntry } from "./api/command.js";
