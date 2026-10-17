/** The values of the table below, before freezing. */
const errorCodeValues = {
  /** Success: the server answers `error id=0 msg=ok`. */
  OK: 0x0000,
  /** Undefined error. */
  Undefined: 0x0001,
  /** Not implemented. */
  NotImplemented: 0x0002,
  /** No message is known for this code. */
  OKNoUpdate: 0x0003,
  /** No message is known for this code. */
  DontNotify: 0x0004,
  /** Library time limit reached. */
  LibTimeLimitReached: 0x0005,
  /** Command not found. */
  CommandNotFound: 0x0100,
  /** Unable to bind network port. */
  UnableToBindNetworkPort: 0x0101,
  /** No network port available. */
  NoNetworkPortAvailable: 0x0102,
  /** Invalid clientID. */
  ClientInvalidID: 0x0200,
  /** Nickname is already in use. */
  ClientNicknameInUse: 0x0201,
  /** Invalid error code. */
  ClientInvalidErrorCode: 0x0202,
  /** Max clients protocol limit reached. */
  ClientProtocolLimitReached: 0x0203,
  /** Invalid client type. */
  ClientInvalidType: 0x0204,
  /** Already subscribed. */
  ClientAlreadySubscribed: 0x0205,
  /** Not logged in. */
  ClientNotLoggedIn: 0x0206,
  /** Could not validate client identity. */
  ClientCouldNotValidateIdentity: 0x0207,
  /** Invalid loginname or password. */
  ClientInvalidPassword: 0x0208,
  /** Too many clones already connected. */
  ClientTooManyClonesConnected: 0x0209,
  /** Client version outdated, please update. */
  ClientVersionOutdated: 0x020a,
  /** Client is online. */
  ClientIsOnline: 0x020b,
  /** Client is flooding. */
  ClientIsFlooding: 0x020c,
  /** Client is modified. */
  ClientHacked: 0x020d,
  /** Can not verify client at this moment. */
  ClientCannotVerifyNow: 0x020e,
  /** Client is not permitted to log in. */
  ClientLoginNotPermitted: 0x020f,
  /** Client is not subscribed to the channel. */
  ClientNotSubscribed: 0x0210,
  /** Invalid channelID. */
  ChannelInvalidID: 0x0300,
  /** Max channels protocol limit reached. */
  ChannelProtocolLimitReached: 0x0301,
  /** Already member of channel. */
  ChannelAlreadyIn: 0x0302,
  /** Channel name is already in use. */
  ChannelNameInUse: 0x0303,
  /** Channel not empty. */
  ChannelNotEmpty: 0x0304,
  /** Can not delete default channel. */
  ChannelCanNotDeleteDefault: 0x0305,
  /** Default channel requires permanent. */
  ChannelDefaultRequirePermanent: 0x0306,
  /** Invalid channel flags. */
  ChannelInvalidFlags: 0x0307,
  /** Permanent channel can not be child of non permanent channel. */
  ChannelParentNotPermanent: 0x0308,
  /** Channel maxclient reached. */
  ChannelMaxClientsReached: 0x0309,
  /** Channel maxfamily reached. */
  ChannelMaxFamilyReached: 0x030a,
  /** Invalid channel order. */
  ChannelInvalidOrder: 0x030b,
  /** Channel does not support filetransfers. */
  ChannelNoFileTransferSupported: 0x030c,
  /** Invalid channel password. */
  ChannelInvalidPassword: 0x030d,
  /** Channel is private channel. */
  ChannelIsPrivateChannel: 0x030e,
  /** Invalid security hash supplied by client. */
  ChannelInvalidSecurityHash: 0x030f,
  /** Invalid serverID. */
  ServerInvalidID: 0x0400,
  /** Server is running. */
  ServerRunning: 0x0401,
  /** Server is shutting down. */
  ServerIsShuttingDown: 0x0402,
  /** Server maxclient reached. */
  ServerMaxClientsReached: 0x0403,
  /** Invalid server password. */
  ServerInvalidPassword: 0x0404,
  /** Deployment active. */
  ServerDeploymentActive: 0x0405,
  /** Unable to stop own server in your connection class. */
  ServerUnableToStopOwnServer: 0x0406,
  /** Server is virtual. */
  ServerIsVirtual: 0x0407,
  /** Server wrong machineID. */
  ServerWrongMachineID: 0x0408,
  /** Server is not running. */
  ServerIsNotRunning: 0x0409,
  /** Server is booting up. */
  ServerIsBooting: 0x040a,
  /** Server got an invalid status for this operation. */
  ServerStatusInvalid: 0x040b,
  /** Server modal quit. */
  ServerModalQuit: 0x040c,
  /** Server version is too old for command. */
  ServerVersionOutdated: 0x040d,
  /** Database error. */
  Database: 0x0500,
  /** Database empty result set. */
  DatabaseEmptyResult: 0x0501,
  /** Database duplicate entry. */
  DatabaseDuplicateEntry: 0x0502,
  /** Database no modifications. */
  DatabaseNoModifications: 0x0503,
  /** Database invalid constraint. */
  DatabaseConstraint: 0x0504,
  /** Database reinvoke command. */
  DatabaseReinvoke: 0x0505,
  /** Invalid quote. */
  ParameterQuote: 0x0600,
  /** Invalid parameter count. */
  ParameterInvalidCount: 0x0601,
  /** Invalid parameter. */
  ParameterInvalid: 0x0602,
  /** Parameter not found. */
  ParameterNotFound: 0x0603,
  /** Convert error. */
  ParameterConvert: 0x0604,
  /** Invalid parameter size. */
  ParameterInvalidSize: 0x0605,
  /** Missing required parameter. */
  ParameterMissing: 0x0606,
  /** Invalid checksum. */
  ParameterChecksum: 0x0607,
  /** Virtual server got a critical error. */
  VsCritical: 0x0700,
  /** Connection lost. */
  ConnectionLost: 0x0701,
  /** Not connected. */
  NotConnected: 0x0702,
  /** No cached connection info. */
  NoCachedConnectionInfo: 0x0703,
  /** Currently not possible. */
  CurrentlyNotPossible: 0x0704,
  /** Failed connection initialization. */
  FailedConnectionInitialisation: 0x0705,
  /** Could not resolve hostname. */
  CouldNotResolveHostname: 0x0706,
  /** Invalid server connection handler ID. */
  InvalidServerConnectionHandlerID: 0x0707,
  /** Could not initialize Input Manager. */
  CouldNotInitialiseInputManager: 0x0708,
  /** Client library not initialized. */
  ClientLibraryNotInitialised: 0x0709,
  /** Server library not initialized. */
  ServerLibraryNotInitialised: 0x070a,
  /** Too many whisper targets. */
  WhisperTooManyTargets: 0x070b,
  /** No whisper targets found. */
  WhisperNoTargets: 0x070c,
  /** Invalid file name. */
  FileInvalidName: 0x0800,
  /** Invalid file permissions. */
  FileInvalidPermissions: 0x0801,
  /** File already exists. */
  FileAlreadyExists: 0x0802,
  /** File not found. */
  FileNotFound: 0x0803,
  /** File input/output error. */
  FileIOError: 0x0804,
  /** Invalid file transfer ID. */
  FileInvalidTransferID: 0x0805,
  /** Invalid file path. */
  FileInvalidPath: 0x0806,
  /** No files available. */
  FileNoFilesAvailable: 0x0807,
  /** Overwrite excludes resume. */
  FileOverwriteExcludesResume: 0x0808,
  /** Invalid file size. */
  FileInvalidSize: 0x0809,
  /** File already in use. */
  FileAlreadyInUse: 0x080a,
  /** Could not open file transfer connection. */
  FileCouldNotOpenConnection: 0x080b,
  /** No space left on device (disk full?) */
  FileNoSpaceLeftOnDevice: 0x080c,
  /** File exceeds file system's maximum file size. */
  FileExceedsFileSystemMaximumSize: 0x080d,
  /** File transfer connection timeout. */
  FileTransferConnectionTimeout: 0x080e,
  /** Lost file transfer connection. */
  FileConnectionLost: 0x080f,
  /** File exceeds supplied file size. */
  FileExceedsSuppliedSize: 0x0810,
  /** File transfer complete. */
  FileTransferComplete: 0x0811,
  /** File transfer canceled. */
  FileTransferCanceled: 0x0812,
  /** File transfer interrupted. */
  FileTransferInterrupted: 0x0813,
  /** File transfer server quota exceeded. */
  FileTransferServerQuotaExceeded: 0x0814,
  /** File transfer client quota exceeded. */
  FileTransferClientQuotaExceeded: 0x0815,
  /** File transfer reset. */
  FileTransferReset: 0x0816,
  /** File transfer limit reached. */
  FileTransferLimitReached: 0x0817,
  /** Preprocessor disabled. */
  SoundPreprocessorDisabled: 0x0900,
  /** Internal preprocessor. */
  SoundInternalPreprocessor: 0x0901,
  /** Internal encoder. */
  SoundInternalEncoder: 0x0902,
  /** Internal playback. */
  SoundInternalPlayback: 0x0903,
  /** No capture device available. */
  SoundNoCaptureDeviceAvailable: 0x0904,
  /** No playback device available. */
  SoundNoPlaybackDeviceAvailable: 0x0905,
  /** Could not open capture device. */
  SoundCouldNotOpenCaptureDevice: 0x0906,
  /** Could not open playback device. */
  SoundCouldNotOpenPlaybackDevice: 0x0907,
  /** ServerConnectionHandler has a device registered. */
  SoundHandlerHasDevice: 0x0908,
  /** Invalid capture device. */
  SoundInvalidCaptureDevice: 0x0909,
  /** Invalid clayback device. */
  SoundInvalidPlaybackDevice: 0x090a,
  /** Invalid wave file. */
  SoundInvalidWave: 0x090b,
  /** Wave file type not supported. */
  SoundUnsupportedWave: 0x090c,
  /** Could not open wave file. */
  SoundOpenWave: 0x090d,
  /** Internal capture. */
  SoundInternalCapture: 0x090e,
  /** Device still in use. */
  SoundDeviceInUse: 0x090f,
  /** Device already registered. */
  SoundDeviceAlreadyRegistered: 0x0910,
  /** Device not registered/known. */
  SoundUnknownDevice: 0x0911,
  /** Unsupported frequency. */
  SoundUnsupportedFrequency: 0x0912,
  /** Invalid channel count. */
  SoundInvalidChannelCount: 0x0913,
  /** Read error in wave. */
  SoundReadWave: 0x0914,
  /** Sound need more data. */
  SoundNeedMoreData: 0x0915,
  /** Sound device was busy. */
  SoundDeviceBusy: 0x0916,
  /** There is no sound data for this period. */
  SoundNoData: 0x0917,
  /** Channelmask set bits count (speakers) is not the same as (count) */
  SoundChannelMaskMismatch: 0x0918,
  /** Invalid group ID. */
  PermissionInvalidGroupID: 0x0a00,
  /** Duplicate entry. */
  PermissionDuplicateEntry: 0x0a01,
  /** Invalid permission ID. */
  PermissionInvalidPermID: 0x0a02,
  /** Empty result set. */
  PermissionEmptyResult: 0x0a03,
  /** Access to default group is forbidden. */
  PermissionDefaultGroupForbidden: 0x0a04,
  /** Invalid size. */
  PermissionInvalidSize: 0x0a05,
  /** Invalid value. */
  PermissionInvalidValue: 0x0a06,
  /** Group is not empty. */
  PermissionsGroupNotEmpty: 0x0a07,
  /** Insufficient client permissions. */
  PermissionsClientInsufficient: 0x0a08,
  /** Insufficient group modify power. */
  PermissionsInsufficientGroupPower: 0x0a09,
  /** Insufficient permission modify power. */
  PermissionsInsufficientPermissionPower: 0x0a0a,
  /** Template group is currently used. */
  PermissionTemplateGroupIsUsed: 0x0a0b,
  /** Permission error. */
  Permissions: 0x0a0c,
  /** Virtualserver limit reached. */
  AccountingVirtualServerLimitReached: 0x0b00,
  /** Max slot limit reached. */
  AccountingSlotLimitReached: 0x0b01,
  /** License file not found. */
  AccountingLicenseFileNotFound: 0x0b02,
  /** License date not ok. */
  AccountingLicenseDateNotOK: 0x0b03,
  /** Unable to connect to accounting server. */
  AccountingUnableToConnectToServer: 0x0b04,
  /** Unknown accounting error. */
  AccountingUnknownError: 0x0b05,
  /** Accounting server error. */
  AccountingServerError: 0x0b06,
  /** Instance limit reached. */
  AccountingInstanceLimitReached: 0x0b07,
  /** Instance check error. */
  AccountingInstanceCheckError: 0x0b08,
  /** License file invalid. */
  AccountingLicenseFileInvalid: 0x0b09,
  /** Virtualserver is running elsewhere. */
  AccountingRunningElsewhere: 0x0b0a,
  /** Virtualserver running in same instance already. */
  AccountingInstanceDuplicated: 0x0b0b,
  /** Virtualserver already started. */
  AccountingAlreadyStarted: 0x0b0c,
  /** Virtualserver not started. */
  AccountingNotStarted: 0x0b0d,
  /** No message is known for this code. */
  AccountingTooManyStarts: 0x0b0e,
  /** Invalid message id. */
  MessageInvalidID: 0x0c00,
  /** Invalid ban id. */
  BanInvalidID: 0x0d00,
  /** Connection failed, you are banned. */
  ConnectFailedBanned: 0x0d01,
  /** Rename failed, new name is banned. */
  RenameFailedBanned: 0x0d02,
  /** Flood ban. */
  BanFlooding: 0x0d03,
  /** Unable to initialize tts. */
  TTSUnableToInitialize: 0x0e00,
  /** Invalid privilege key. */
  PrivilegeKeyInvalid: 0x0f00,
  /** No message is known for this code. */
  VoipPjsua: 0x1000,
  /** No message is known for this code. */
  VoipAlreadyInitialized: 0x1001,
  /** No message is known for this code. */
  VoipTooManyAccounts: 0x1002,
  /** No message is known for this code. */
  VoipInvalidAccount: 0x1003,
  /** No message is known for this code. */
  VoipInternalError: 0x1004,
  /** No message is known for this code. */
  VoipInvalidConnectionID: 0x1005,
  /** No message is known for this code. */
  VoipCannotAnswerInitiatedCall: 0x1006,
  /** No message is known for this code. */
  VoipNotInitialized: 0x1007,
  /** Invalid password. */
  ProvisioningInvalidPassword: 0x1100,
  /** Invalid request. */
  ProvisioningInvalidRequest: 0x1101,
  /** No(more) slots available. */
  ProvisioningNoSlotsAvailable: 0x1102,
  /** Pool missing. */
  ProvisioningPoolMissing: 0x1103,
  /** Pool unknown. */
  ProvisioningPoolUnknown: 0x1104,
  /** Unknown ip location(perhaps LAN ip?) */
  ProvisioningUnknownIPLocation: 0x1105,
  /** Internal error(tried exceeded) */
  ProvisioningInternalTriesExceeded: 0x1106,
  /** Too many slots requested. */
  ProvisioningTooManySlotsRequested: 0x1107,
  /** Too many reserved. */
  ProvisioningTooManyReserved: 0x1108,
  /** Could not connect to provisioning server. */
  ProvisioningCouldNotConnect: 0x1109,
  /** Authentication server not connected. */
  ProvisioningAuthServerNotConnected: 0x1110,
  /** Authentication data too large. */
  ProvisioningAuthDataTooLarge: 0x1111,
  /** Already initialized. */
  ProvisioningAlreadyInitialized: 0x1112,
  /** Not initialized. */
  ProvisioningNotInitialized: 0x1113,
  /** Already connecting. */
  ProvisioningConnecting: 0x1114,
  /** Already connected. */
  ProvisioningAlreadyConnected: 0x1115,
  /** No message is known for this code. */
  ProvisioningNotConnected: 0x1116,
  /** Io_error. */
  ProvisioningIOError: 0x1117,
  /** No message is known for this code. */
  ProvisioningInvalidTimeout: 0x1118,
  /** No message is known for this code. */
  ProvisioningTS3ServerNotFound: 0x1119,
  /** Unknown permissionID. */
  ProvisioningNoPermission: 0x111a,
  /**
   * Out of scope: WebQuery refused a command outside the scope of the api key
   * that made the request, or outside the guest scope of a request that carried
   * none. HTTP 401.
   */
  APIKeyOutOfScope: 0x1400,
  /**
   * Invalid apikey: WebQuery does not accept the api key sent, or the key may
   * not address the virtual server in the path. HTTP 401.
   */
  APIKeyInvalid: 0x1402,
  /**
   * Missing apikey: the request carried no api key, or an empty one, and the
   * server offers no guest access. HTTP 401.
   */
  APIKeyMissing: 0x1404,
} as const;
/**
 * The error codes a TeamSpeak server reports, by name.
 *
 * A {@link ServerError} carries the code as a number, so a caller matches a
 * specific refusal by comparing it:
 *
 * ```ts
 * if (err instanceof ServerError && err.code === ErrorCode.ChannelInvalidPassword) { ... }
 * ```
 *
 * The table holds the codes TeamSpeak 3 and 6 servers share. A server may
 * report a code missing here, so `ServerError.code` is a plain number.
 */
export const ErrorCode: typeof errorCodeValues = /* @__PURE__ */ Object.freeze(errorCodeValues);

/** A known TeamSpeak server error code. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
