/**
 * The events a TeamSpeak client receives from the server. Every kind of client
 * shares these types.
 */

import type { ChannelGroupID, ChannelID, ClientID, ServerGroupID, UID } from "./command/ids.js";
import type { ClientChanges, ClientEntry } from "./api/clients.js";
import type { NotificationName } from "./notification-name.js";

/** A text message, sent privately, to a channel, or to the whole server. */
export interface TextMessageEvent {
  /** The sender's nickname. */
  readonly invokerName: string;
  /** The sender's unique identifier. */
  readonly invokerUID: UID;
  /** The message, unescaped. */
  readonly message: string;
  /**
   * The sender's server groups. A text message does not carry them; they are
   * those of the sender as the client knows it, so they are `undefined` for a
   * sender the client has not seen.
   */
  readonly invokerGroups: readonly ServerGroupID[] | undefined;
  /**
   * Private, channel or server; compare it with `TextMessageTarget`. A plain
   * number, since a server may send a mode that table does not name.
   */
  readonly targetMode: number;
  /**
   * The client a private message was sent to. Channel and server messages
   * carry no target, so it is 0 for them.
   */
  readonly targetID: ClientID;
  /** The sender. */
  readonly invokerID: ClientID;
}

/** A client changing channel, of its own accord or moved by someone. */
export interface ClientMovedEvent {
  /** Who moved the client; the client itself for a move of its own. */
  readonly invokerName: string;
  /** The mover's unique identifier. */
  readonly invokerUID: UID;
  /** The channel the client is now in. */
  readonly targetChannelID: ChannelID;
  /** Why the client moved; compare it with `Reason`. */
  readonly reason: number;
  /** The message that came with the move, such as a channel kick's reason; "" when none. */
  readonly reasonMessage: string;
  /** The client that moved. */
  readonly clientID: ClientID;
  /** The mover. */
  readonly invokerID: ClientID;
}

/**
 * A client going out of view: leaving the server, kicked or banned from it, or
 * in a channel that stopped being subscribed.
 */
export interface ClientLeaveEvent {
  /** The reason given for a kick or a ban, or the client's own parting message. */
  readonly reasonMessage: string;
  /** Why the client left; compare it with `Reason`. */
  readonly reason: number;
  /** The client that left. */
  readonly clientID: ClientID;
  /** Who kicked or banned the client; empty otherwise. */
  readonly invokerName: string;
  /** The kicker's unique identifier; empty unless kicked or banned. */
  readonly invokerUID: UID;
  /** The kicker; 0 unless kicked or banned. */
  readonly invokerID: ClientID;
}

/** This client being kicked from its channel or the server. */
export interface KickedEvent {
  /** The reason the invoker gave. */
  readonly reasonMessage: string;
  /** `Reason.KickChannel`, `Reason.KickServer` or `Reason.KickServerBan`. */
  readonly reason: number;
  /** Who kicked this client. */
  readonly invokerName: string;
  /** The kicker's unique identifier. */
  readonly invokerUID: UID;
  /** The kicker. */
  readonly invokerID: ClientID;
}

/**
 * A client coming into view: the same record `listClients` returns, so one
 * type describes a client however it was learned of; its own id is `id`, as
 * in every record. The fields only `clientlist -times` reports are undefined
 * here.
 */
export type ClientEnterEvent = ClientEntry;

/** This client being poked. */
export interface PokeEvent {
  /** Who poked. */
  readonly invokerName: string;
  /** The poker's unique identifier. */
  readonly invokerUID: UID;
  /** The poker. */
  readonly invokerID: ClientID;
  /** The poke's message, unescaped. */
  readonly message: string;
}

/** Who caused a notification: the three fields every invoked notification carries. */
export interface Invoked {
  /** The invoking client's id; 0 when the server acted or no invoker was named. */
  readonly invokerID: ClientID;
  /** Its nickname; "Server" when the server acted, "" when none was named. */
  readonly invokerName: string;
  /** Its unique identifier; "" when the server acted or none was named. */
  readonly invokerUID: UID;
}

/** A client's properties changing. Delivered by the voice client only. */
export interface ClientUpdatedEvent extends Invoked {
  /** The client that changed. It may be this client. */
  readonly clientID: ClientID;
  /**
   * Only the properties the notification carried. It may be empty, when the
   * notification carried only properties this SDK does not model. Merge it
   * into a record with `applyClientChanges`.
   */
  readonly changes: ClientChanges;
}

/**
 * A client gaining or losing a server group. The group event says which group
 * and who changed it; the client's whole new list arrives as `clientUpdated`.
 */
export interface ClientServerGroupEvent extends Invoked {
  /** The server group. */
  readonly groupID: ServerGroupID;
  /** The client whose membership changed. */
  readonly clientID: ClientID;
  /** That client's nickname. */
  readonly nickname: string;
  /** That client's unique identifier. */
  readonly uid: UID;
}

/** A client added to a server group. */
export interface ClientServerGroupAddedEvent extends ClientServerGroupEvent {}

/** A client removed from a server group. */
export interface ClientServerGroupRemovedEvent extends ClientServerGroupEvent {}

/**
 * A client's channel group changing in a channel. Moving a client reports one
 * as well, from the server (invoker id 0, name "Server"), since the group is
 * per channel.
 */
export interface ClientChannelGroupChangedEvent extends Invoked {
  /** The client whose channel group changed. */
  readonly clientID: ClientID;
  /** The channel the group applies in. */
  readonly channelID: ChannelID;
  /** The channel group the client now holds there. */
  readonly channelGroupID: ChannelGroupID;
  /** The channel the group is inherited from. */
  readonly channelGroupInheritedChannelID: ChannelID;
}

/** Audio from another client, in the channel or whispered. */
export interface VoiceDataEvent {
  /** Who is speaking. */
  readonly clientID: ClientID;
  /**
   * How the audio is encoded; compare it with `Codec`. A plain number, since a
   * server may relay a codec that table does not name.
   */
  readonly codec: number;
  /** One encoded frame, copied: it stays valid after the listener returns. */
  readonly data: Uint8Array;
}

/**
 * A notification from the server, as it arrived: the escape hatch for one the
 * SDK does not model, and for the ones it does. Match its `name` against
 * `NotificationName`.
 *
 * This is the catch-all layer: the client delivers every notification as one
 * of these, including the ones that also have a typed event of their own,
 * which it delivers first. So a notification is never taken out of the
 * catch-all by being given a typed event.
 */
export interface NotificationEvent {
  /** The notification's name, such as `notifyserveredited`; `NotificationName` lists the known ones. */
  readonly name: NotificationName | (string & {});
  /** Its parameters, unescaped. */
  readonly params: Readonly<Record<string, string>>;
}

/** What `connected` delivers. */
export interface ConnectedEvent {
  /**
   * Whether the reconnect loop made this connection, rather than a call to
   * `connect()`.
   */
  readonly reconnected: boolean;
}

/** What `disconnected` delivers. */
export interface DisconnectedEvent {
  /**
   * `undefined` after `disconnect()`, and the cause otherwise, such as a failed
   * handshake, the connection timing out, or the client being removed.
   */
  readonly error: Error | undefined;
  /**
   * Whether the reconnect loop will try again, as of this event. False after
   * `disconnect()`, without `reconnect` options, when `shouldRetry` refuses
   * this cause, and once `backoff.maxAttempts` is spent. A `disconnect()` or a
   * manual `connect()` while it waits can still end the loop.
   */
  readonly willReconnect: boolean;
}

/**
 * The events a server sends, by name, that every kind of client delivers.
 *
 * These are the modelled events; `notification` carries every notification
 * besides, after the event it produced. Gaining a key is an additive change,
 * so a minor release may add one; none is ever removed in a minor. The keys
 * are not listed here, so this comment cannot fall behind them.
 */
export interface ServerEventMap {
  /** A text message to this client, its channel or the server. */
  textMessage: TextMessageEvent;
  /** A client coming into view, including every client already there on connecting. */
  clientEnter: ClientEnterEvent;
  /** A client going out of view. */
  clientLeave: ClientLeaveEvent;
  /** A client changing channel. */
  clientMoved: ClientMovedEvent;
  /**
   * Every notification the server sends, modelled or not, after any event it
   * produces. A notification with an event of its own still arrives here: this
   * is the catch-all layer, so the typed event is delivered alongside it, never
   * instead of it.
   */
  notification: NotificationEvent;
}

/**
 * The events about a connection's own life, by name, that every kind of client
 * delivers.
 *
 * `connected` and `disconnected` come from the client's own lifecycle rather
 * than from a notification, so nothing on the catch-all carries them. `kicked`
 * is not of that kind: it is derived from the `notifyclientleftview` or
 * `notifyclientmoved` that reports this client kicked, so that notification
 * reaches the catch-all as well. What the three share is the delivery, not the
 * origin: they go out on the client's own path, which event middleware does
 * not see, because they are about the connection rather than about the
 * server's event stream. `kicked` is the convenience event for the one case it
 * names, this client kicked from the server or from its channel. Gaining a key
 * is additive, and none is removed in a minor release.
 */
export interface SessionEventMap {
  /** The handshake completing, on `connect()` and on every reconnection. */
  connected: ConnectedEvent;
  /**
   * The connection ending, after `disconnect()`, a drop, or a failed attempt;
   * the event says why and whether the reconnect loop will try again.
   */
  disconnected: DisconnectedEvent;
  /**
   * This client being kicked from its channel or the server: derived from the
   * `notifyclientmoved` or `notifyclientleftview` that reports it, so that
   * notification also arrives on the catch-all. A kick from the server ends
   * the connection as well, which `disconnected` reports.
   */
  kicked: KickedEvent;
}
