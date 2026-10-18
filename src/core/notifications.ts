/**
 * The notifications a server pushes, read as the events every client
 * delivers.
 *
 * The voice protocol and ServerQuery carry the same notifications — a move is
 * `notifyclientmoved` on both — and only their framing differs, which each
 * client's own reader takes care of. So the parsing lives here, and both
 * clients call it rather than keeping a copy each.
 *
 * A result is one notification's worth: the event it makes, plus what only the
 * client can decide, such as whether a client that left view was itself.
 */

import {
  asChannelGroupID,
  asChannelID,
  asClientID,
  asServerGroupID,
  asUID,
} from "./command/ids.js";
import { parseClient, parseClientChanges } from "./api/parse.js";
import { parseChannelChanges } from "./api/command.js";
import { Reason } from "./reason.js";
import { applyClientChanges } from "./api/clients.js";
import { parseInt10, parseUint16, parseUint64 } from "./helpers.js";
import type { Command } from "./command/command.js";
import type { ChannelID } from "./command/ids.js";
import type { ClientEntry } from "./api/clients.js";
import type {
  ChannelCreatedEvent,
  ChannelDeletedEvent,
  ChannelDescriptionChangedEvent,
  ChannelEditedEvent,
  ChannelMovedEvent,
  ChannelPasswordChangedEvent,
  ChannelSubscribedEvent,
  ChannelUnsubscribedEvent,
  ClientChatClosedEvent,
  ClientChatComposingEvent,
  ClientEnterEvent,
  ClientChannelGroupChangedEvent,
  ClientLeaveEvent,
  ClientMovedEvent,
  ClientServerGroupAddedEvent,
  ClientServerGroupRemovedEvent,
  ClientUpdatedEvent,
  Invoked,
  PluginCommandEvent,
  PokeEvent,
  ServerEditedEvent,
  TextMessageEvent,
} from "./events.js";

/** What one notification amounts to. */
export type NotificationResult =
  | { kind: "clientEnter"; info: ClientEnterEvent }
  | { kind: "clientLeave"; event: ClientLeaveEvent; isSelf: boolean }
  | { kind: "clientMoved"; event: ClientMovedEvent }
  | { kind: "textMessage"; message: TextMessageEvent }
  | { kind: "poked"; event: PokeEvent }
  | { kind: "clientUpdated"; event: ClientUpdatedEvent }
  | { kind: "clientServerGroupAdded"; event: ClientServerGroupAddedEvent }
  | { kind: "clientServerGroupRemoved"; event: ClientServerGroupRemovedEvent }
  | { kind: "clientChannelGroupChanged"; event: ClientChannelGroupChangedEvent }
  | { kind: "channelCreated"; event: ChannelCreatedEvent }
  | { kind: "channelEdited"; event: ChannelEditedEvent }
  | { kind: "channelMoved"; event: ChannelMovedEvent }
  | { kind: "channelDeleted"; event: ChannelDeletedEvent }
  | { kind: "channelDescriptionChanged"; event: ChannelDescriptionChangedEvent }
  | { kind: "channelPasswordChanged"; event: ChannelPasswordChangedEvent }
  | { kind: "serverEdited"; event: ServerEditedEvent }
  | { kind: "channelSubscribed"; event: ChannelSubscribedEvent }
  | { kind: "channelUnsubscribed"; event: ChannelUnsubscribedEvent }
  | { kind: "pluginCommand"; event: PluginCommandEvent }
  | { kind: "clientChatComposing"; event: ClientChatComposingEvent }
  | { kind: "clientChatClosed"; event: ClientChatClosedEvent }
  | { kind: "unknown" };

/**
 * Read a notification. `cmd` is the parsed notification line, `selfCLID` this
 * client's own id (0 when it is not known yet), and `clients` the clients the
 * caller knows, which the enter, leave, move, update and channel group
 * notifications keep current and the others read: a text message carries no
 * groups, and a move of the client's own carries no invoker. An entry is
 * replaced, never edited, so an event that holds one stays as it was.
 *
 * The server-group notifications leave the clients alone: the update that
 * accompanies them carries the whole new list, in either order, and is the
 * only writer of it.
 */
export function handleNotification(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientEntry>,
): NotificationResult {
  switch (cmd.name) {
    case "notifycliententerview":
      return handleClientEnterView(cmd, clients);
    case "notifyclientleftview":
      return handleClientLeftView(cmd, selfCLID, clients);
    case "notifyclientmoved":
      return handleClientMoved(cmd, clients);
    case "notifytextmessage":
      return handleTextMessage(cmd, clients);
    case "notifyclientpoke":
      return handleClientPoked(cmd);
    case "notifyclientupdated":
      return handleClientUpdated(cmd, clients);
    case "notifyservergroupclientadded":
      return handleServerGroupMember(cmd, "clientServerGroupAdded");
    case "notifyservergroupclientdeleted":
      return handleServerGroupMember(cmd, "clientServerGroupRemoved");
    case "notifyclientchannelgroupchanged":
      return handleClientChannelGroupChanged(cmd, clients);
    case "notifychannelcreated":
      return handleChannelCreated(cmd);
    case "notifychanneledited":
      return handleChannelEdited(cmd);
    case "notifychannelmoved":
      return handleChannelMoved(cmd);
    case "notifychanneldeleted":
      return channelNotification(cmd, "channelDeleted", invoked(cmd.params));
    case "notifychanneldescriptionchanged":
      return channelNotification(cmd, "channelDescriptionChanged", {});
    case "notifychannelpasswordchanged":
      return channelNotification(cmd, "channelPasswordChanged", {});
    case "notifyserveredited":
      return handleServerEdited(cmd);
    case "notifychannelsubscribed":
      return channelNotification(cmd, "channelSubscribed", {});
    case "notifychannelunsubscribed":
      return channelNotification(cmd, "channelUnsubscribed", {});
    case "notifyplugincmd":
      return {
        kind: "pluginCommand",
        event: {
          name: cmd.params["name"] ?? "",
          data: cmd.params["data"] ?? "",
          ...invoked(cmd.params),
        },
      };
    case "notifyclientchatcomposing":
      return handleChatComposing(cmd);
    case "notifyclientchatclosed":
      return handleChatClosed(cmd);
    default:
      return { kind: "unknown" };
  }
}

function handleClientEnterView(
  cmd: Command,
  clients: Map<number, ClientEntry>,
): NotificationResult {
  const info = parseClient(cmd.params);
  // No client has id 0: a row without one describes nobody.
  if (info.id === 0) return { kind: "unknown" };
  // The roster keeps the record alone; the event adds where it came from and why.
  clients.set(info.id, info);
  return {
    kind: "clientEnter",
    info: {
      ...info,
      ...channelOf(cmd.params, "cfid", "fromChannelID"),
      ...(cmd.params["reasonid"] === undefined
        ? {}
        : { reason: parseInt10(cmd.params["reasonid"]) }),
    },
  };
}

/** A channel id the row names under `key`, as `{ [name]: id }`; nothing when the row lacks the key. */
function channelOf<N extends string>(
  params: Readonly<Record<string, string>>,
  key: string,
  name: N,
): { [K in N]?: ChannelID } {
  const raw = params[key];
  return raw === undefined
    ? {}
    : ({ [name]: asChannelID(parseUint64(raw)) } as { [K in N]?: ChannelID });
}

function handleClientLeftView(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientEntry>,
): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };
  const isSelf = clid === selfCLID;
  clients.delete(clid);
  return {
    kind: "clientLeave",
    event: {
      clientID: clid,
      ...channelOf(cmd.params, "cfid", "fromChannelID"),
      ...channelOf(cmd.params, "ctid", "targetChannelID"),
      reason: parseInt10(cmd.params["reasonid"] ?? ""),
      reasonMessage: cmd.params["reasonmsg"] ?? "",
      invokerID: asClientID(parseUint16(cmd.params["invokerid"] ?? "")),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? ""),
    },
    isSelf,
  };
}

function handleClientMoved(cmd: Command, clients: Map<number, ClientEntry>): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  const ctid = asChannelID(parseUint64(cmd.params["ctid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };

  const existing = clients.get(clid);
  if (existing) clients.set(clid, { ...existing, channelID: ctid });

  // A move the client made itself names no invoker, so the fields are empty;
  // the client it knows by `clid` is who that was.
  const invokerID = asClientID(parseUint16(cmd.params["invokerid"] ?? ""));
  const invoker = clients.get(invokerID === 0 ? clid : invokerID);

  return {
    kind: "clientMoved",
    event: {
      clientID: clid,
      targetChannelID: ctid,
      ...channelOf(cmd.params, "cfid", "fromChannelID"),
      reason: parseInt10(cmd.params["reasonid"] ?? ""),
      reasonMessage: cmd.params["reasonmsg"] ?? "",
      invokerID,
      invokerName: cmd.params["invokername"] ?? invoker?.nickname ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? invoker?.uid ?? ""),
    },
  };
}

function handleTextMessage(cmd: Command, clients: Map<number, ClientEntry>): NotificationResult {
  const invokerID = asClientID(parseUint16(cmd.params["invokerid"] ?? ""));
  const invokerInfo = clients.get(invokerID);

  const message: TextMessageEvent = {
    targetMode: parseInt10(cmd.params["targetmode"] ?? ""),
    targetID: asClientID(parseUint16(cmd.params["target"] ?? "")),
    invokerID,
    invokerName: cmd.params["invokername"] ?? "",
    invokerUID: asUID(cmd.params["invokeruid"] ?? invokerInfo?.uid ?? ""),
    message: cmd.params["msg"] ?? "",
    invokerGroups: invokerInfo?.serverGroups,
  };

  return { kind: "textMessage", message };
}

function handleClientPoked(cmd: Command): NotificationResult {
  return {
    kind: "poked",
    event: {
      invokerID: asClientID(parseUint16(cmd.params["invokerid"] ?? "")),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? ""),
      message: cmd.params["msg"] ?? "",
    },
  };
}

function invoked(params: Readonly<Record<string, string>>): Invoked {
  return {
    invokerID: asClientID(parseUint16(params["invokerid"] ?? "")),
    invokerName: params["invokername"] ?? "",
    invokerUID: asUID(params["invokeruid"] ?? ""),
  };
}

function handleClientUpdated(cmd: Command, clients: Map<number, ClientEntry>): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };
  const changes = parseClientChanges(cmd.params);

  // A client that is not known gets no entry: one needs a uid and a channel,
  // which an update does not carry. The event is still delivered.
  const existing = clients.get(clid);
  if (existing) clients.set(clid, applyClientChanges(existing, changes));

  return { kind: "clientUpdated", event: { clientID: clid, changes, ...invoked(cmd.params) } };
}

function handleServerGroupMember(
  cmd: Command,
  kind: "clientServerGroupAdded" | "clientServerGroupRemoved",
): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };
  return {
    kind,
    event: {
      groupID: asServerGroupID(parseUint64(cmd.params["sgid"] ?? "")),
      clientID: clid,
      nickname: cmd.params["name"] ?? "",
      uid: asUID(cmd.params["cluid"] ?? ""),
      ...invoked(cmd.params),
    },
  };
}

function handleClientChannelGroupChanged(
  cmd: Command,
  clients: Map<number, ClientEntry>,
): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };
  const channelID = asChannelID(parseUint64(cmd.params["cid"] ?? ""));
  const channelGroupID = asChannelGroupID(parseUint64(cmd.params["cgid"] ?? ""));
  const inherited = asChannelID(parseUint64(cmd.params["cgi"] ?? ""));

  // The group is per channel: only the channel the client is in is the one
  // its record describes.
  const existing = clients.get(clid);
  if (existing && existing.channelID === channelID) {
    clients.set(clid, {
      ...existing,
      channelGroupID,
      channelGroupInheritedChannelID: inherited,
    });
  }

  return {
    kind: "clientChannelGroupChanged",
    event: {
      clientID: clid,
      channelID,
      channelGroupID,
      channelGroupInheritedChannelID: inherited,
      ...invoked(cmd.params),
    },
  };
}

/** A channel id from a notification; 0 for a row that has none, which no channel has. */
function channelIDOf(params: Readonly<Record<string, string>>, key = "cid") {
  return asChannelID(parseUint64(params[key] ?? ""));
}

/**
 * A notification that names a channel and nothing else of note: `fields` is
 * what else its event holds. A row without a channel describes nothing.
 */
function channelNotification<
  K extends
    | "channelDeleted"
    | "channelDescriptionChanged"
    | "channelPasswordChanged"
    | "channelSubscribed"
    | "channelUnsubscribed",
>(
  cmd: Command,
  kind: K,
  fields: Partial<Invoked>,
): Extract<NotificationResult, { kind: K }> | { kind: "unknown" } {
  const channelID = channelIDOf(cmd.params);
  if (channelID === 0n) return { kind: "unknown" };
  return { kind, event: { channelID, ...fields } } as Extract<NotificationResult, { kind: K }>;
}

function handleChannelCreated(cmd: Command): NotificationResult {
  const channelID = channelIDOf(cmd.params);
  if (channelID === 0n) return { kind: "unknown" };
  return {
    kind: "channelCreated",
    event: {
      channelID,
      parentID: channelIDOf(cmd.params, "cpid"),
      changes: parseChannelChanges(cmd.params),
      ...invoked(cmd.params),
    },
  };
}

function handleChannelEdited(cmd: Command): NotificationResult {
  const channelID = channelIDOf(cmd.params);
  if (channelID === 0n) return { kind: "unknown" };
  const reason = parseInt10(cmd.params["reasonid"] ?? "");
  // The server answers `channelgetdescription` with an edit of this kind that
  // names no invoker: the description it was asked for, not a change. Told
  // apart by what it holds, not by whether a command is waiting, so a real
  // edit that arrives meanwhile is not swallowed. It still reaches the
  // catch-all, and the command's answer.
  if (reason === Reason.ChannelUpdate && cmd.params["invokerid"] === undefined) {
    return { kind: "unknown" };
  }
  return {
    kind: "channelEdited",
    event: { channelID, reason, changes: parseChannelChanges(cmd.params), ...invoked(cmd.params) },
  };
}

function handleChannelMoved(cmd: Command): NotificationResult {
  const channelID = channelIDOf(cmd.params);
  if (channelID === 0n) return { kind: "unknown" };
  return {
    kind: "channelMoved",
    event: {
      channelID,
      parentID: channelIDOf(cmd.params, "cpid"),
      order: channelIDOf(cmd.params, "order"),
      reason: parseInt10(cmd.params["reasonid"] ?? ""),
      ...invoked(cmd.params),
    },
  };
}

function handleServerEdited(cmd: Command): NotificationResult {
  const changes: Record<string, string> = {};
  for (const [key, value] of Object.entries(cmd.params)) {
    if (key.startsWith("virtualserver_")) changes[key] = value;
  }
  return { kind: "serverEdited", event: { changes, ...invoked(cmd.params) } };
}

function handleChatComposing(cmd: Command): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };
  return {
    kind: "clientChatComposing",
    event: { clientID: clid, uid: asUID(cmd.params["cluid"] ?? "") },
  };
}

function handleChatClosed(cmd: Command): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };
  return {
    kind: "clientChatClosed",
    event: { clientID: clid, uid: asUID(cmd.params["cluid"] ?? "") },
  };
}
