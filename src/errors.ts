export class TeamspeakError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeamspeakError";
  }
}

export class ServerError extends TeamspeakError {
  readonly id: string;
  readonly serverMessage: string;

  constructor(id: string, serverMessage: string) {
    super(`TeamSpeak server error: ${serverMessage} (id=${id})`);
    this.name = "ServerError";
    this.id = id;
    this.serverMessage = serverMessage;
  }
}

export class CommandTimeoutError extends TeamspeakError {
  readonly command: string;

  constructor(command: string) {
    super(`command timeout: ${command}`);
    this.name = "CommandTimeoutError";
    this.command = command;
  }
}

export class AlreadyConnectedError extends TeamspeakError {
  constructor() {
    super("already connecting or connected");
    this.name = "AlreadyConnectedError";
  }
}

export class EAXTagMismatchError extends TeamspeakError {
  constructor() {
    super("EAX tag mismatch");
    this.name = "EAXTagMismatchError";
  }
}

export class FakeSignatureMismatchError extends TeamspeakError {
  constructor() {
    super("fake signature mismatch");
    this.name = "FakeSignatureMismatchError";
  }
}

export class FileTransferError extends TeamspeakError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileTransferError";
  }
}

export class FileTransferTimeoutError extends TeamspeakError {
  constructor() {
    super("timeout waiting for file transfer notification");
    this.name = "FileTransferTimeoutError";
  }
}

export class CryptoInitError extends TeamspeakError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CryptoInitError";
  }
}

export class InvalidIdentityError extends TeamspeakError {
  constructor(message = "invalid identity format") {
    super(message);
    this.name = "InvalidIdentityError";
  }
}
