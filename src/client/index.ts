/**
 * A clean-room TeamSpeak client: it connects over the voice protocol, the way
 * the TeamSpeak application does.
 *
 * Only what belongs to the voice protocol is exported here. The typed commands,
 * ids and errors every client shares come from `@honeybbq/teamspeak`.
 *
 * @module @honeybbq/teamspeak/client
 */

// The client
export { Client } from "./client.js";
export { EventName, GroupWhisperType, GroupWhisperScope } from "./types.js";

export type { ServerView, ViewReadyEvent, ViewStatus } from "./view.js";

export type {
  EventMap,
  EventMiddleware,
  ServerEvent,
  ServerEventName,
  VoiceOptions,
  WhisperTargets,
  GroupWhisperTarget,
  AddrResolver,
  ClientOptions,
  ResolvedAddr,
  DatagramSocket,
  SocketFactory,
  FileTransferSocketFactory,
} from "./types.js";

export {
  FileTransferError,
  HandshakeError,
  InvalidAddressError,
  InvalidIdentityError,
  RemovedError,
  ConnectionTimeoutError,
} from "./errors.js";

// Commands only the voice protocol has.
export * from "./api/voice.js";
export * from "./api/avatars.js";

// File transfer data
export { dialFileTransfer, uploadFileData, downloadFileData } from "./transfer.js";
export type {
  FileTransferOptions,
  FileTransferTrace,
  FileTransferStage,
  FileTransferDialStartInfo,
  FileTransferDialDoneInfo,
  FileTransferProgressInfo,
  FileTransferDoneInfo,
  FileTransferFailedInfo,
} from "./transfer.js";

// Tracing a connection attempt
export { ConnectPhase } from "./trace.js";
export type {
  ClientTrace,
  ResolveStartInfo,
  ResolveDoneInfo,
  ConnectStartInfo,
  ConnectDoneInfo,
  HandshakeDoneInfo,
  SessionStartInfo,
  WelcomeDoneInfo,
  AttemptFailedInfo,
  ReconnectScheduledInfo,
  DisconnectStartInfo,
  DisconnectDoneInfo,
  SessionEndInfo,
  ReconnectStoppedInfo,
} from "./trace.js";

// Server capabilities, read from the handshake
export { unknownServerCapabilities } from "./capabilities.js";
export type { ServerCapabilities } from "./capabilities.js";

// Tracing points for diagnostics_channel subscribers
export { commandChannel, incomingChannel } from "./diagnostics.js";
export type { CommandTrace, IncomingTrace } from "./diagnostics.js";

// Reconnection policy
export { defaultShouldRetry } from "./reconnect.js";

// Identity
export {
  Identity,
  parseIdentity,
  generateIdentity,
  generateIdentitySync,
  uidFromPublicKey,
} from "./crypto/index.js";
export type { UIDAlgorithm } from "./crypto/index.js";
