// ---- Branded primitive types ------------------------------------------------

/** A TS3-escaped string. Obtained only via escape(). */
export type EscapedString = string & { readonly __escaped: unique symbol };

// ---- Event map --------------------------------------------------------------

export interface TextMessage {
  invokerName: string;
  invokerUID: string;
  message: string;
  invokerGroups: string[];
  targetMode: number;
  targetID: bigint;
  invokerID: number;
}

export interface ClientMovedEvent {
  invokerName: string;
  invokerUID: string;
  targetChannelID: bigint;
  reasonID: number;
  id: number;
  invokerID: number;
}

export interface ClientLeftViewEvent {
  reasonMsg: string;
  reasonID: number;
  id: number;
  targetID: number;
}

export interface ClientInfo {
  nickname: string;
  uid: string;
  serverGroups: string[];
  channelID: bigint;
  type: number;
  id: number;
}

export interface ChannelInfo {
  name: string;
  description: string;
  id: bigint;
  parentID: bigint;
}

export interface FileUploadInfo {
  fileTransferKey: string;
  seekPosition: bigint;
  clientFileTransferID: number;
  serverFileTransferID: number;
  port: number;
}

export interface FileDownloadInfo {
  fileTransferKey: string;
  size: bigint;
  clientFileTransferID: number;
  serverFileTransferID: number;
  port: number;
}

export interface FileTransferStatusInfo {
  message: string;
  status: number;
  clientFileTransferID: number;
}

export interface PokeEvent {
  invokerName: string;
  invokerUID: string;
  invokerID: number;
  message: string;
}

export interface VoiceData {
  clientId: number;
  codec: number;
  data: Uint8Array;
}

// ---- Typed event map used by Client.on() ------------------------------------

export interface EventMap {
  textMessage: TextMessage;
  clientEnter: ClientInfo;
  clientLeave: ClientLeftViewEvent;
  clientMoved: ClientMovedEvent;
  poked: PokeEvent;
  voiceData: VoiceData;
  connected: void;
  disconnected: Error | undefined;
  kicked: string;
}

// ---- Client status ----------------------------------------------------------

export const enum ClientStatus {
  Disconnected = 0,
  Connecting = 1,
  Connected = 2,
}

// ---- Middleware types --------------------------------------------------------

export type CommandMiddleware = (
  next: (cmd: string) => Promise<void>,
) => (cmd: string) => Promise<void>;

export type EventMiddleware = (
  next: (evt: EventMap[keyof EventMap]) => void,
) => (evt: EventMap[keyof EventMap]) => void;

// ---- Logger interface --------------------------------------------------------

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** A no-op logger that discards all messages. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** A console-backed logger. */
export const consoleLogger: Logger = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// ---- Resolved address (from discovery) --------------------------------------

export interface ResolvedAddr {
  addr: string;
  source: string;
  expiry: Date;
}

// ---- AddrResolver interface -------------------------------------------------

export interface AddrResolver {
  resolve(addr: string, signal?: AbortSignal): Promise<ResolvedAddr[]>;
}

// ---- ClientOptions ----------------------------------------------------------

export interface ClientOptions {
  logger?: Logger;
  resolver?: AddrResolver;
  commandMiddleware?: CommandMiddleware[];
  eventMiddleware?: EventMiddleware[];
  /** Server password sent during the initial `clientinit` handshake. */
  serverPassword?: string;
  /** Default channel name to join during the initial `clientinit` handshake. */
  defaultChannel?: string;
  /** Password for `defaultChannel`, sent during the initial `clientinit` handshake. */
  defaultChannelPassword?: string;
}
