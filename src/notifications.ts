import type { Command } from "./command/command.js";
import { unescape } from "./command/command.js";
import type {
  ClientInfo,
  ClientLeftViewEvent,
  ClientMovedEvent,
  TextMessage,
  PokeEvent,
  FileUploadInfo,
  FileDownloadInfo,
  FileTransferStatusInfo,
} from "./types.js";
import { parseUint64, parseUint16, parseInt10 } from "./helpers.js";

export type NotificationResult =
  | { kind: "clientEnter"; info: ClientInfo }
  | { kind: "clientLeave"; event: ClientLeftViewEvent; isSelf: boolean }
  | { kind: "clientMoved"; event: ClientMovedEvent }
  | { kind: "textMessage"; message: TextMessage }
  | { kind: "poked"; event: PokeEvent }
  | { kind: "startUpload"; info: FileUploadInfo }
  | { kind: "startDownload"; info: FileDownloadInfo }
  | { kind: "fileTransferStatus"; info: FileTransferStatusInfo }
  | { kind: "unknown" };

export function handleNotification(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientInfo>,
  nickname: string,
): NotificationResult {
  switch (cmd.name) {
    case "notifycliententerview":
      return handleClientEnterView(cmd, clients, nickname);
    case "notifyclientleftview":
      return handleClientLeftView(cmd, selfCLID, clients);
    case "notifyclientmoved":
      return handleClientMoved(cmd, clients);
    case "notifytextmessage":
      return handleTextMessage(cmd, clients);
    case "notifyclientpoke":
      return handleClientPoked(cmd);
    case "notifystartupload":
      return { kind: "startUpload", info: handleStartUpload(cmd) };
    case "notifystartdownload":
      return { kind: "startDownload", info: handleStartDownload(cmd) };
    case "notifystatusfiletransfer":
      return { kind: "fileTransferStatus", info: handleFileTransferStatus(cmd) };
    default:
      return { kind: "unknown" };
  }
}

function handleClientEnterView(
  cmd: Command,
  clients: Map<number, ClientInfo>,
  _nickname: string,
): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const cid = parseUint64(cmd.params["cid"] ?? "");
  const clientType = parseInt10(cmd.params["client_type"] ?? "");
  const groupsStr = cmd.params["client_servergroups"] ?? "";

  const info: ClientInfo = {
    id: clid,
    nickname: cmd.params["client_nickname"] ?? "",
    uid: cmd.params["client_unique_identifier"] ?? "",
    channelID: cid,
    type: clientType,
    serverGroups: groupsStr ? groupsStr.split(",") : [],
  };

  if (clid !== 0) {
    clients.set(clid, info);
  }

  return { kind: "clientEnter", info };
}

function handleClientLeftView(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientInfo>,
): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const reasonID = parseInt10(cmd.params["reasonid"] ?? "");

  const isSelf = clid === selfCLID;
  if (clid !== 0) clients.delete(clid);

  return {
    kind: "clientLeave",
    event: {
      id: clid,
      reasonID,
      reasonMsg: cmd.params["reasonmsg"] ?? "",
      targetID: parseUint16(cmd.params["targetid"] ?? ""),
    },
    isSelf,
  };
}

function handleClientMoved(cmd: Command, clients: Map<number, ClientInfo>): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const ctid = parseUint64(cmd.params["ctid"] ?? "");

  if (clid !== 0) {
    const existing = clients.get(clid);
    if (existing) clients.set(clid, { ...existing, channelID: ctid });
  }

  return {
    kind: "clientMoved",
    event: {
      id: clid,
      targetChannelID: ctid,
      reasonID: parseInt10(cmd.params["reasonid"] ?? ""),
      invokerID: parseUint16(cmd.params["invokerid"] ?? ""),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: cmd.params["invokeruid"] ?? "",
    },
  };
}

function handleTextMessage(cmd: Command, clients: Map<number, ClientInfo>): NotificationResult {
  const invokerID = parseUint16(cmd.params["invokerid"] ?? "");
  const invokerInfo = clients.get(invokerID);

  const message: TextMessage = {
    targetMode: parseInt10(cmd.params["targetmode"] ?? ""),
    targetID: parseUint64(cmd.params["target"] ?? ""),
    invokerID,
    invokerName: cmd.params["invokername"] ?? "",
    invokerUID: cmd.params["invokeruid"] ?? invokerInfo?.uid ?? "",
    message: unescape(cmd.params["msg"] ?? ""),
    invokerGroups: invokerInfo?.serverGroups ?? [],
  };

  return { kind: "textMessage", message };
}

function handleStartUpload(cmd: Command): FileUploadInfo {
  return {
    clientFileTransferID: parseUint16(cmd.params["clientftfid"] ?? ""),
    serverFileTransferID: parseUint16(cmd.params["serverftfid"] ?? ""),
    fileTransferKey: cmd.params["ftkey"] ?? "",
    port: parseUint16(cmd.params["port"] ?? ""),
    seekPosition: parseUint64(cmd.params["seekpos"] ?? ""),
  };
}

function handleStartDownload(cmd: Command): FileDownloadInfo {
  return {
    clientFileTransferID: parseUint16(cmd.params["clientftfid"] ?? ""),
    serverFileTransferID: parseUint16(cmd.params["serverftfid"] ?? ""),
    fileTransferKey: cmd.params["ftkey"] ?? "",
    port: parseUint16(cmd.params["port"] ?? ""),
    size: parseUint64(cmd.params["size"] ?? ""),
  };
}

function handleFileTransferStatus(cmd: Command): FileTransferStatusInfo {
  return {
    clientFileTransferID: parseUint16(cmd.params["clientftfid"] ?? ""),
    status: parseInt10(cmd.params["status"] ?? ""),
    message: cmd.params["msg"] ?? "",
  };
}

function handleClientPoked(cmd: Command): NotificationResult {
  return {
    kind: "poked",
    event: {
      invokerID: parseUint16(cmd.params["invokerid"] ?? ""),
      invokerName: unescape(cmd.params["invokername"] ?? ""),
      invokerUID: cmd.params["invokeruid"] ?? "",
      message: unescape(cmd.params["msg"] ?? ""),
    },
  };
}
