// Main client
export { Client, ClientStatus } from "./client.js";
export type { ClientState } from "./client.js";

// Public types
export type {
  TextMessage,
  ClientMovedEvent,
  ClientLeftViewEvent,
  ClientInfo,
  ChannelInfo,
  PokeEvent,
  VoiceData,
  FileUploadInfo,
  FileDownloadInfo,
  FileTransferStatusInfo,
  EventMap,
  CommandMiddleware,
  EventMiddleware,
  Logger,
  AddrResolver,
  ClientOptions,
  ResolvedAddr,
  EscapedString,
} from "./types.js";
export { noopLogger, consoleLogger } from "./types.js";

// Errors
export {
  TeamspeakError,
  ServerError,
  CommandTimeoutError,
  AlreadyConnectedError,
  EAXTagMismatchError,
  FakeSignatureMismatchError,
  FileTransferError,
  FileTransferTimeoutError,
  CryptoInitError,
  InvalidIdentityError,
} from "./errors.js";

// High-level API helpers
export {
  sendTextMessage,
  clientMove,
  poke,
  getClientInfo,
  listChannels,
  listClients,
  fileTransferDeleteFile,
} from "./api.js";

// File transfer utilities
export { dialFileTransfer, uploadFileData, downloadFileData } from "./transfer.js";

// Crypto (re-exported for identity management)
export {
  Identity,
  identityFromString,
  generateIdentity,
  getUidFromPublicKey,
} from "./crypto/index.js";
