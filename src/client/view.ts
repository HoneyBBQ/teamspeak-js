import {
  ChannelTree,
  NotConnectedError,
  TeamspeakError,
  asChannelID,
  type Channel,
  type ChannelCreatedEvent,
  type ChannelDeletedEvent,
  type ChannelEditedEvent,
  type ChannelID,
  type ChannelMovedEvent,
  type ClientEnterEvent,
  type ClientEntry,
  type ChannelGroup,
  type ChannelGroupID,
  type ClientID,
  type Logger,
  type ServerGroup,
  type ServerGroupID,
} from "@honeybbq/teamspeak";
import { abortReason } from "./abort.js";

/**
 * Where a {@link ServerView} is in a connection's life.
 *
 * - `"empty"`: this client has not tried to connect.
 * - `"loading"`: a connection is being made and the server has not finished
 *   its welcome. The view holds what has arrived, which is not yet the tree.
 * - `"live"`: the welcome is complete and the connection is up. The view
 *   follows the server's notifications.
 * - `"stale"`: the connection ended. The view still holds what it last knew,
 *   which no longer changes; the next `connect()` clears it.
 *
 * @experimental New in 1.x and may change in a minor release.
 */
export type ViewStatus = "empty" | "loading" | "live" | "stale";

/**
 * What `viewReady` delivers.
 *
 * @experimental New in 1.x and may change in a minor release.
 */
export interface ViewReadyEvent {
  /** The view's `revision` when it became live. */
  readonly revision: number;
}

/**
 * What `viewChanged` delivers.
 *
 * @experimental New in 1.x and may change in a minor release.
 */
export interface ViewChangedEvent {
  /** The view's `revision` when the event was delivered. */
  readonly revision: number;
}

/**
 * What a connected client knows of the server: the channels in the server's
 * order, the clients it has been told about, and itself. It is read-only and
 * always on; `client.view` is the one view a client has, for all its
 * connections.
 *
 * The view is changed by the packet handler, before the typed event that
 * reports the change is queued, and events are delivered after the packet is
 * handled. So a listener sees a view at least as new as its event: with two
 * notifications in one packet, the first listener already sees both. A caller
 * that needs the state at each event follows the events; a caller that shows
 * the state now reads the view.
 *
 * Nothing the view returned is changed afterwards: a channel or client
 * record, and each array and `channels` map, stays as it was when it was
 * read, and a change replaces it, `clients` and `channels` maps included.
 * `revision` tells whether anything changed.
 *
 * What is known differs by part:
 *
 * - The channels are exact, for the channels the server shows this client.
 *   Their order is derived from the events, because the server changes the
 *   order of a sibling without announcing it. See `ChannelTree`.
 * - The clients are those the server announced and has not since withdrawn:
 *   the ones in the channel this client joined, and in every channel it
 *   subscribed to afterwards. The server does not say who is in the others,
 *   and does not say when a subscription ends, so the view drops a channel's
 *   clients when it sees `channelUnsubscribed`. It is not a list of everyone on
 *   the server; `listClients` is, for the moment it is called.
 * - The group definitions are the server's last full list of each kind, which
 *   it sends again whole after any group is added, renamed, copied or deleted.
 *   A change to a group's permissions is not announced, and is not in the view.
 * - The server's properties are exact for those the server announces when
 *   they change, and as of the last `getServerVariables` for the others.
 *
 * @experimental New in 1.x and may change in a minor release: the shape of the
 * view and its names are still settling.
 */
export interface ServerView {
  /** Where the view is in the connection's life. */
  readonly status: ViewStatus;
  /**
   * A number that increases with every change to the view: a channel, a
   * client, or `status`. It never goes back, a new connection included, so a
   * caller can compare it to skip work.
   */
  readonly revision: number;
  /**
   * Resolves once `status` is `"live"`, and at once when it already is.
   * Rejects with the connection's error when the connection ends first, as it
   * does when `status` is `"stale"`, and with the signal's reason when
   * `signal` aborts. While `"empty"` or `"loading"` it waits.
   */
  whenReady(options?: { readonly signal?: AbortSignal | undefined }): Promise<void>;

  /**
   * Every channel the server showed this client, parents before children and
   * siblings in order, so `[...view.channels.values()]` is the order to
   * display them in.
   *
   * A record's `order` is the channel before it among its siblings, derived
   * from the events, and its `totalClients` and `totalFamilyClients` are
   * `undefined`: the server counts the clients in a channel once, in the
   * welcome, and sends nothing after, so a count held here would be wrong
   * from the first client that moved. Count `clientsIn` instead.
   */
  readonly channels: ReadonlyMap<ChannelID, Channel>;
  /** The channel, or `undefined` for one the view does not hold. */
  channel(id: ChannelID): Channel | undefined;
  /**
   * The channels directly under `parent`, in sibling order; the top level for
   * `undefined` or 0. Empty for an id the view does not hold.
   */
  children(parent?: ChannelID): readonly Channel[];
  /**
   * The channel and its ancestors, root first, so the channel is last. Empty
   * for an id the view does not hold.
   */
  path(id: ChannelID): readonly Channel[];

  /**
   * The clients this client knows of, which is not every client on the
   * server: see {@link ServerView}. The same records the client's events and
   * `invokerGroups` read. The map is as the clients were when it was read: a
   * change makes the next read a new map.
   */
  readonly clients: ReadonlyMap<ClientID, ClientEntry>;
  /** The client, or `undefined` for one the view does not know of. */
  client(id: ClientID): ClientEntry | undefined;
  /** The known clients in the channel, by id. */
  clientsIn(id: ChannelID): readonly ClientEntry[];
  /** This client's own record; `undefined` until the welcome has delivered it. */
  readonly self: ClientEntry | undefined;

  /**
   * The server groups, in the server's order, which is ascending id. A change
   * to the list makes the next read a new map; a client's `serverGroups` can
   * name an id that is not in it for a moment, so look ups must allow for a
   * miss. Empty until `groupsLoaded`.
   */
  readonly serverGroups: ReadonlyMap<ServerGroupID, ServerGroup>;
  /** The channel groups, as `serverGroups` is for server groups. */
  readonly channelGroups: ReadonlyMap<ChannelGroupID, ChannelGroup>;
  /**
   * True once both group lists of this connection have arrived. The server
   * sends them right after the welcome, so `viewReady` can come first: the
   * `viewChanged` that follows reports them. It is `false` again from the next
   * `connect()` and stays `true` once `"stale"`.
   */
  readonly groupsLoaded: boolean;
  /**
   * The server's `virtualserver_*` properties by wire name, the keys
   * `getServerInfo` returns and `PropertyName` names. A change makes the next
   * read a new object.
   *
   * It starts from what the server says on joining. It then follows the edits
   * the server announces, and merges every `getServerVariables` answer. The
   * server announces an edit only to a property that answer does not carry; a
   * change to the welcome message, the host message or the maximum number of
   * clients, among others, arrives as an empty `serverEdited`. Call
   * `getServerVariables` after one to bring those up to date. The counters and
   * statistics that change by themselves (clients online, uptime, traffic) are
   * never held.
   */
  readonly server: Readonly<Record<string, string>>;
}

/**
 * The clients a client knows, by id. Every change to it, whoever makes it, is
 * a change to the view, so it counts them.
 */
export class Roster extends Map<number, ClientEnterEvent> {
  #changed: () => void = () => {};

  /** Call `changed` after each change from now on. */
  onChange(changed: () => void): void {
    this.#changed = changed;
  }

  override set(id: number, entry: ClientEnterEvent): this {
    super.set(id, entry);
    this.#changed();
    return this;
  }

  override delete(id: number): boolean {
    const had = super.delete(id);
    if (had) this.#changed();
    return had;
  }

  override clear(): void {
    const had = this.size > 0;
    super.clear();
    if (had) this.#changed();
  }
}

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

const TOP = asChannelID(0n);

/**
 * The `virtualserver_*` properties of `servergetvariables` that change by
 * themselves. A number nothing keeps current would be wrong from the next
 * second, so the view never holds one.
 */
const COUNTERS: ReadonlySet<string> = new Set(
  [
    "clientsonline",
    "queryclientsonline",
    "channelsonline",
    "uptime",
    "client_connections",
    "query_client_connections",
    "month_bytes_downloaded",
    "month_bytes_uploaded",
    "total_bytes_downloaded",
    "total_bytes_uploaded",
    "total_packetloss_speech",
    "total_packetloss_keepalive",
    "total_packetloss_control",
    "total_packetloss_total",
    "total_ping",
  ].map((name) => `virtualserver_${name}`),
);

/** The `virtualserver_*` entries of `params`, less the counters when `counters` is false. */
function serverEntries(
  params: Readonly<Record<string, string>>,
  counters: boolean,
): Array<[string, string]> {
  return Object.entries(params).filter(
    ([key]) => key.startsWith("virtualserver_") && (counters || !COUNTERS.has(key)),
  );
}

/** Whether two records hold the same values under the same keys. */
function sameRecord(a: object, b: object): boolean {
  const left = Object.entries(a);
  const right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(([key, value], i) => {
      const other = right[i]!;
      return key === other[0] && Object.is(value, other[1]);
    })
  );
}

/** Whether two lists hold the same groups in the same order. */
function sameGroups(a: ReadonlyMap<bigint, object>, b: ReadonlyMap<bigint, object>): boolean {
  if (a.size !== b.size) return false;
  const right = [...b];
  let i = 0;
  for (const [id, group] of a) {
    const other = right[i++]!;
    if (id !== other[0] || !sameRecord(group, other[1])) return false;
  }
  return true;
}

/** The channels of `tree`, parents first and siblings in order, in one map. */
function preorder(tree: ChannelTree): ReadonlyMap<ChannelID, Channel> {
  const out = new Map<ChannelID, Channel>();
  const walk = (parent: ChannelID): void => {
    for (const channel of tree.children(parent)) {
      out.set(channel.id, channel);
      walk(channel.id);
    }
  };
  walk(TOP);
  return out;
}

/**
 * The state behind `client.view`, and its only writer: the client's packet
 * handler. `view` is what the client hands out.
 */
export class ViewStore {
  /** The clients, shared with the client's own roster. */
  readonly roster: Roster = new Roster();
  readonly view: ServerView;

  #logger: Logger;
  #selfID: () => number;
  #status: ViewStatus = "empty";
  #revision = 0;
  #tree = ChannelTree.from([]);
  /** The `channellist` rows of the welcome in progress, in arrival order. */
  #rows: Channel[] = [];
  #known: { readonly revision: number; readonly clients: ReadonlyMap<ClientID, ClientEntry> };
  #ordered: { readonly tree: ChannelTree; readonly channels: ReadonlyMap<ChannelID, Channel> };
  #serverGroups: ReadonlyMap<ServerGroupID, ServerGroup> = new Map();
  #channelGroups: ReadonlyMap<ChannelGroupID, ChannelGroup> = new Map();
  #serverGroupsSeen = false;
  #channelGroupsSeen = false;
  #server: Readonly<Record<string, string>> = {};
  /** The revision `viewReady` or `viewChanged` last reported. */
  #announced = 0;
  #changed: () => void;
  #waiters = new Set<Waiter>();
  /** Why the last connection ended. */
  #endedBy: Error | undefined;

  /** `changed` is called when the revision moves outside a loading view, so an event can follow. */
  constructor(logger: Logger, selfID: () => number, changed: () => void = () => {}) {
    this.#logger = logger;
    this.#selfID = selfID;
    this.#changed = changed;
    this.#ordered = { tree: this.#tree, channels: new Map() };
    this.#known = { revision: this.#revision, clients: new Map() };
    this.roster.onChange(() => this.#bump());

    // oxlint-disable-next-line no-this-alias -- accessors cannot be arrow functions
    const store = this;
    this.view = {
      get status() {
        return store.#status;
      },
      get revision() {
        return store.#revision;
      },
      whenReady: (options) => this.#whenReady(options?.signal),
      get channels() {
        if (store.#ordered.tree !== store.#tree) {
          store.#ordered = { tree: store.#tree, channels: preorder(store.#tree) };
        }
        return store.#ordered.channels;
      },
      channel: (id) => this.#tree.get(id),
      children: (parent) => this.#tree.children(parent),
      path: (id) => this.#tree.path(id),
      get clients() {
        if (store.#known.revision !== store.#revision) {
          store.#known = {
            revision: store.#revision,
            clients: new Map(store.roster) as unknown as ReadonlyMap<ClientID, ClientEntry>,
          };
        }
        return store.#known.clients;
      },
      client: (id) => this.roster.get(id),
      clientsIn: (id) =>
        [...this.roster.values()]
          .filter((entry) => entry.channelID === id)
          .sort((a, b) => a.id - b.id),
      get self() {
        const id = store.#selfID();
        return id === 0 ? undefined : store.roster.get(id);
      },
      get serverGroups() {
        return store.#serverGroups;
      },
      get channelGroups() {
        return store.#channelGroups;
      },
      get groupsLoaded() {
        return store.#groupsLoaded();
      },
      get server() {
        return store.#server;
      },
    };
  }

  /** A connection begins: what the last one left is cleared. */
  reset(): void {
    this.roster.clear();
    this.#rows = [];
    this.#tree = ChannelTree.from([]);
    this.#serverGroups = new Map();
    this.#channelGroups = new Map();
    this.#serverGroupsSeen = false;
    this.#channelGroupsSeen = false;
    this.#server = {};
    this.#status = "loading";
    this.#bump();
  }

  /** The revision moved. */
  #bump(): void {
    this.#revision++;
    if (this.#status !== "loading") this.#changed();
  }

  /**
   * The revision to announce with `viewChanged`, or `undefined` when there is
   * nothing to say: the view is loading, or it is as it was when the last
   * `viewReady` or `viewChanged` reported it.
   */
  announce(): number | undefined {
    if (this.#status === "loading" || this.#status === "empty") return undefined;
    if (this.#revision === this.#announced) return undefined;
    this.#announced = this.#revision;
    return this.#revision;
  }

  /** A `channellist` row of the welcome. */
  collect(row: Channel): void {
    if (this.#status === "loading") this.#rows.push(row);
  }

  /**
   * The welcome's last row has arrived: the tree is built and the view is live.
   * Returns the revision it became live at, or `undefined` when it was not
   * waiting for the welcome.
   */
  finish(): number | undefined {
    if (this.#status !== "loading") return undefined;
    // The server counts a channel's clients once, in the welcome.
    const rows = this.#rows.map((row) => ({
      ...row,
      totalClients: undefined,
      totalFamilyClients: undefined,
    }));
    this.#rows = [];
    this.#tree = ChannelTree.from(rows);
    if (!this.#tree.consistent) this.#logger.debug("the channel list is not a tree");
    this.#status = "live";
    this.#bump();
    this.#announced = this.#revision;
    for (const waiter of this.#waiters) waiter.resolve();
    return this.#revision;
  }

  /** A channel being created, applied to the tree. */
  applyCreated(event: ChannelCreatedEvent): void {
    this.#change("channelCreated", event.channelID, (tree) => tree.applyCreated(event));
  }

  /** A channel being edited, applied to the tree. */
  applyEdited(event: ChannelEditedEvent): void {
    this.#change("channelEdited", event.channelID, (tree) => tree.applyEdited(event));
  }

  /** A channel being moved, applied to the tree. */
  applyMoved(event: ChannelMovedEvent): void {
    this.#change("channelMoved", event.channelID, (tree) => tree.applyMoved(event));
  }

  /** A channel being deleted, applied to the tree. */
  applyDeleted(event: ChannelDeletedEvent): void {
    this.#change("channelDeleted", event.channelID, (tree) => tree.applyDeleted(event));
  }

  #change(name: string, channelID: ChannelID, next: (tree: ChannelTree) => ChannelTree): void {
    if (this.#status !== "live") return;
    const before = this.#tree;
    this.#tree = next(before);
    this.#bump();
    if (before.consistent && !this.#tree.consistent) {
      this.#logger.debug("a channel event could not be placed", {
        event: name,
        channel: String(channelID),
      });
    }
  }

  /**
   * The server stopped telling this client about a channel's clients, and did
   * not say they left: forget them. This client's own record stays.
   */
  dropChannel(channelID: ChannelID): void {
    const self = this.#selfID();
    for (const [id, entry] of this.roster) {
      if (entry.channelID === channelID && id !== self) this.roster.delete(id);
    }
  }

  /**
   * The server's list of its server groups, one line of rows. It replaces the
   * set, so a group the line lacks is gone; a row without an id is skipped.
   */
  setServerGroups(groups: readonly ServerGroup[]): void {
    if (!this.#accepting()) return;
    const loaded = this.#groupsLoaded();
    const next = new Map<ServerGroupID, ServerGroup>();
    for (const group of groups) next.set(group.id, group);
    this.#serverGroupsSeen = true;
    const changed = !sameGroups(this.#serverGroups, next);
    if (changed) this.#serverGroups = next;
    if (changed || loaded !== this.#groupsLoaded()) this.#bump();
  }

  /** The server's list of its channel groups; see {@link ViewStore.setServerGroups}. */
  setChannelGroups(groups: readonly ChannelGroup[]): void {
    if (!this.#accepting()) return;
    const loaded = this.#groupsLoaded();
    const next = new Map<ChannelGroupID, ChannelGroup>();
    for (const group of groups) next.set(group.id, group);
    this.#channelGroupsSeen = true;
    const changed = !sameGroups(this.#channelGroups, next);
    if (changed) this.#channelGroups = next;
    if (changed || loaded !== this.#groupsLoaded()) this.#bump();
  }

  #groupsLoaded(): boolean {
    return this.#serverGroupsSeen && this.#channelGroupsSeen;
  }

  /** The `initserver` parameters: the server's own properties are kept, nothing of the client's. */
  seedServer(params: Readonly<Record<string, string>>): void {
    this.#mergeServer(serverEntries(params, true));
  }

  /** An edit the server announced. */
  patchServer(changes: Readonly<Record<string, string>>): void {
    this.#mergeServer(serverEntries(changes, true));
  }

  /** An answer to `servergetvariables`, whoever asked: merged, less the counters. */
  mergeServer(params: Readonly<Record<string, string>>): void {
    this.#mergeServer(serverEntries(params, false));
  }

  #mergeServer(entries: ReadonlyArray<[string, string]>): void {
    if (!this.#accepting()) return;
    if (entries.every(([key, value]) => this.#server[key] === value)) return;
    this.#server = { ...this.#server, ...Object.fromEntries(entries) };
    this.#bump();
  }

  /** Group lists and server properties are taken while loading and live, not once stale. */
  #accepting(): boolean {
    return this.#status === "loading" || this.#status === "live";
  }

  /** The channel as the view holds it, for the event that reports its deletion. */
  channelBeforeDeletion(id: ChannelID): Channel | undefined {
    return this.#status === "live" ? this.#tree.get(id) : undefined;
  }

  /** The connection ended, for `error`; undefined for a disconnect. */
  end(error: unknown): void {
    if (this.#status !== "loading" && this.#status !== "live") return;
    this.#status = "stale";
    this.#bump();
    this.#endedBy =
      error === undefined
        ? new NotConnectedError()
        : error instanceof Error
          ? error
          : new TeamspeakError("the connection ended", { cause: error });
    for (const waiter of this.#waiters) waiter.reject(this.#endedBy);
  }

  #whenReady(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.#status === "live") return Promise.resolve();
    if (this.#status === "stale") return Promise.reject(this.#endedBy ?? new NotConnectedError());
    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        signal?.removeEventListener("abort", onAbort);
        this.#waiters.delete(waiter);
      };
      const waiter: Waiter = {
        resolve: () => {
          settle();
          resolve();
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      const onAbort = (): void => waiter.reject(abortReason(signal!));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.add(waiter);
    });
  }
}
