/**
 * The events a TeamSpeak client receives from the server. Every kind of client
 * shares these types.
 */

import type { ChannelGroupID, ChannelID, ClientID, ServerGroupID, UID } from "./command/ids.js";
import type { ClientChanges, ClientEntry } from "./api/clients.js";
import type { Channel, ChannelChanges } from "./api/command.js";
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
   *
   * A ServerQuery connection is not sent `notifyclientupdated`, so for a query
   * client they are the groups from the listing taken on connecting, kept
   * current only by clients entering, leaving and moving: a change of groups
   * made since is not in them.
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
  /**
   * Who moved the client; "" when the server names no one, which it does not
   * for a move of the client's own (reason 0).
   */
  readonly invokerName: string;
  /** The mover's unique identifier; "" when none is named. */
  readonly invokerUID: UID;
  /** The channel the client is now in. */
  readonly targetChannelID: ChannelID;
  /**
   * The channel the client came from: `cfid`, or when the server sends none
   * (TS3 3.13.8 sends no `cfid` on a move, TS6 6.0.0 does) the channel the
   * client was known to be in. Absent only when the server sent none and the
   * client was not known. A client's own roster entry is updated before the
   * event is delivered, so this is the only place the previous channel is.
   */
  readonly fromChannelID?: ChannelID | undefined;
  /** Why the client moved; compare it with `Reason`. */
  readonly reason: number;
  /** The message that came with the move, such as a channel kick's reason; "" when none. */
  readonly reasonMessage: string;
  /** The client that moved. */
  readonly clientID: ClientID;
  /** The mover; 0 when the server names no one, as for a move of the client's own. */
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
  /**
   * The channel the client was in (`cfid`); absent when the server sent none.
   * Both servers sent it on every leave measured.
   */
  readonly fromChannelID?: ChannelID | undefined;
  /**
   * The channel the client went to (`ctid`), named as on the move event; 0
   * when it left the server, and absent when the server sent none.
   */
  readonly targetChannelID?: ChannelID | undefined;
  /** Who kicked or banned the client; empty otherwise. */
  readonly invokerName: string;
  /** The kicker's unique identifier; empty unless kicked or banned. */
  readonly invokerUID: UID;
  /** The kicker; 0 unless kicked or banned. */
  readonly invokerID: ClientID;
  /**
   * The client's record as the voice client held it just before it left, so a
   * listener can name who left. Absent when the client never announced it, and
   * always absent on a ServerQuery client, which keeps no such record.
   *
   * @experimental New in 1.x and may change in a minor release.
   */
  readonly previous?: ClientEntry | undefined;
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
 * A client coming into view: the record `listClients` returns, so one type
 * describes a client however it was learned of, with what only the
 * notification says. Its own id is `id`, as in every record. The notification
 * carries every field but the ones only `clientlist` reports (`-times`,
 * `-info`, `-ip`), which are undefined here.
 *
 * `fromChannelID` and `reason` belong to the event: the roster and
 * `view.clients` keep the record without them.
 */
export interface ClientEnterEvent extends ClientEntry {
  /**
   * The channel the client came from (`cfid`); 0 for a client that joined the
   * server, and absent when the server sent none. Measured on TS3 3.13.8 and
   * TS6 6.0.0-beta13.1: 0 on a join and on a client listed by a subscription.
   */
  readonly fromChannelID?: ChannelID | undefined;
  /**
   * Why the client came into view (`reasonid`); compare it with `Reason`.
   * Measured on both servers: 0 on a join, 2 (`Reason.Subscription`) for a
   * client that was already there and came into view by a subscription.
   */
  readonly reason?: number | undefined;
}

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
   * into a record with `applyClientChanges`. A property the notification
   * cleared, such as an icon of 0, is there with the value `undefined`.
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

/** A channel being created. */
export interface ChannelCreatedEvent extends Invoked {
  /** The new channel. */
  readonly channelID: ChannelID;
  /** The channel it sits under, or 0 at the top level. */
  readonly parentID: ChannelID;
  /**
   * The properties the server sent, which are the ones that differ from a new
   * channel's defaults: a property that is absent is the server's default,
   * not unknown. The name is always there and the description never is, since
   * the server does not send it; `channelDescriptionChanged` follows when the
   * channel has one. `parentID` is among them as well, since the server sent
   * it. Merge it into a record with `applyChannelChanges`.
   */
  readonly changes: ChannelChanges;
}

/** A channel's properties being edited. */
export interface ChannelEditedEvent extends Invoked {
  /** The channel that changed. */
  readonly channelID: ChannelID;
  /** Why it changed; `Reason.ChannelEdit` for an edit. A plain number, like every reason. */
  readonly reason: number;
  /**
   * Only the properties the notification carried; a property that is absent
   * did not change, and one the notification cleared, such as an icon of 0, is
   * there with the value `undefined`. It is empty for a change of the description, which
   * `channelDescriptionChanged` reports instead, and a password change carries
   * `hasPassword` only when the password was set or removed.
   */
  readonly changes: ChannelChanges;
}

/** A channel being moved under another channel, or reordered. */
export interface ChannelMovedEvent extends Invoked {
  /** The channel that moved. */
  readonly channelID: ChannelID;
  /** The channel it now sits under, or 0 at the top level. */
  readonly parentID: ChannelID;
  /** The sibling it now sorts after, or 0 for first; the channel's `order`. */
  readonly order: ChannelID;
  /** Why it moved; compare it with `Reason`. */
  readonly reason: number;
}

/**
 * A channel being deleted: by someone, or by the server when an empty
 * temporary channel expired, which names the invoker "Server" with id 0.
 */
export interface ChannelDeletedEvent extends Invoked {
  /** The channel that was deleted. */
  readonly channelID: ChannelID;
  /**
   * The channel as the voice client's view held it just before the deletion
   * (its `order` derived, its client counts `undefined`), so a listener can name
   * what went. Absent when the view did not hold it, such as before the view is
   * live, and always absent on a ServerQuery client, which has no view. A
   * channel deleted with its children gives one event per child, children
   * first, each with its own record.
   *
   * @experimental New in 1.x and may change in a minor release.
   */
  readonly previous?: Channel | undefined;
}

/**
 * A channel's description changing. The new text is not in it, nor in the
 * `channelEdited` that goes with it: fetch it with `getChannelInfo`, or with
 * the voice client's `getChannelDescription`.
 */
export interface ChannelDescriptionChangedEvent {
  /** The channel whose description changed. */
  readonly channelID: ChannelID;
}

/**
 * A channel's password being set, changed or removed. It always follows a
 * password change, while the `channelEdited` that goes with it carries
 * `hasPassword` only when the password was set or removed.
 */
export interface ChannelPasswordChangedEvent {
  /** The channel whose password changed. */
  readonly channelID: ChannelID;
}

/** The server's own settings being edited. */
export interface ServerEditedEvent extends Invoked {
  /**
   * The changed properties by the names the server sends
   * (`virtualserver_name`), which are the keys `getServerInfo` has and
   * `PropertyName` names. It is empty for a change of a property the server
   * does not report here, such as the welcome message. There is no `reason`:
   * TeamSpeak 6 sends none.
   */
  readonly changes: Readonly<Record<string, string>>;
}

/** This client being subscribed to a channel. Delivered by the voice client only. */
export interface ChannelSubscribedEvent {
  /** The channel. */
  readonly channelID: ChannelID;
}

/**
 * This client no longer being subscribed to a channel, by its own request or
 * because the server withdrew it. Delivered by the voice client only.
 *
 * The server does not announce that the clients in the channel left view, and
 * tells nothing more about them afterwards, so they are no longer known: the
 * voice client drops them from its roster and view when this arrives, before
 * it is delivered. Who is in a channel that is not subscribed to cannot be
 * known from events; `listClients` says, for the instant it is called.
 */
export interface ChannelUnsubscribedEvent {
  /** The channel. */
  readonly channelID: ChannelID;
}

/**
 * A plugin command from a client, to the channel, the server or this client
 * alone. The sender receives its own command too, when it was addressed to
 * the sender's channel or the server. Delivered by the voice client only.
 */
export interface PluginCommandEvent extends Invoked {
  /** The command's name, which the plugins agree on. */
  readonly name: string;
  /** Its payload, unescaped; "" when the sender sent none. */
  readonly data: string;
}

/** A client typing a private message to this client. Delivered by the voice client only. */
export interface ClientChatComposingEvent {
  /** The client that is typing. */
  readonly clientID: ClientID;
  /** Its unique identifier. */
  readonly uid: UID;
}

/**
 * A client closed its private chat with this client. It is delivered only to a
 * client the sender has sent a private message to. Delivered by the voice
 * client only.
 */
export interface ClientChatClosedEvent {
  /** The client that closed the chat. */
  readonly clientID: ClientID;
  /** Its unique identifier. */
  readonly uid: UID;
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
  /**
   * One encoded frame, copied: it stays valid after the listener returns. Empty
   * when the speaker stopped talking: it is the end of that speech, not a
   * frame to decode.
   */
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
  /**
   * A client coming into view, including every client already there on
   * connecting. Only the clients of channels this client is subscribed to are
   * announced: on connecting, those in the channel it joined, and later those
   * of a channel it subscribes to or moves into. It is not a list of the
   * server's clients, and a client in any other channel is not known until
   * then; see `channelUnsubscribed` for how that ends.
   */
  clientEnter: ClientEnterEvent;
  /** A client going out of view. */
  clientLeave: ClientLeaveEvent;
  /** A client changing channel. */
  clientMoved: ClientMovedEvent;
  /** A channel being created. */
  channelCreated: ChannelCreatedEvent;
  /**
   * A channel's properties being edited. The answer to a description fetch
   * is not one: the server sends it as an edit with reason `Reason.ChannelUpdate`
   * and no invoker, which produces no event here and reaches `notification`.
   */
  channelEdited: ChannelEditedEvent;
  /** A channel being moved or reordered. */
  channelMoved: ChannelMovedEvent;
  /** A channel being deleted. */
  channelDeleted: ChannelDeletedEvent;
  /** A channel's description changing; the text is not in it. */
  channelDescriptionChanged: ChannelDescriptionChangedEvent;
  /** A channel's password being set, changed or removed. */
  channelPasswordChanged: ChannelPasswordChangedEvent;
  /** The server's settings being edited. */
  serverEdited: ServerEditedEvent;
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
