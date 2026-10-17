/**
 * The channels of a server as a tree whose sibling order is exact, and the
 * rules that keep it so across the channel events.
 */

import { asChannelID, type ChannelID } from "./command/ids.js";
import { applyChannelChanges, parseChannel } from "./api/command.js";
import type { Channel } from "./api/command.js";
import type {
  ChannelCreatedEvent,
  ChannelDeletedEvent,
  ChannelEditedEvent,
  ChannelMovedEvent,
} from "./events.js";

/** The parent of a top-level channel. */
const TOP = asChannelID(0n);

/** The contents of a tree while one operation builds the next. */
interface Draft {
  readonly channels: Map<ChannelID, Channel>;
  /** The ids under each parent, in sibling order. A parent without children has no entry. */
  readonly kids: Map<ChannelID, ChannelID[]>;
  consistent: boolean;
}

/**
 * The channels of a server, parents before children and siblings in the
 * server's order. A tree never changes: `applyCreated`, `applyEdited`,
 * `applyMoved` and `applyDeleted` return the next one, so a tree that was
 * handed out stays as it was.
 *
 * The server sorts siblings by naming, for each, the sibling it comes after
 * (`order`, with 0 for first), and it rewrites that name on the sibling that
 * follows a change without telling anyone. So the tree keeps each parent's
 * children as a list and derives `order` from the position in it: the `order`
 * of a channel a tree holds is the id of the channel before it, whatever the
 * row or event it came from said. That is also what the server sends on the
 * next connection.
 *
 * It follows the channel events. A created channel goes after the sibling its
 * `order` names, with 0 for first. A moved channel leaves its old parent and
 * goes after the sibling named in its new one, together with its subchannels.
 * An edit that carries `order` is a move within the parent. A deleted channel
 * is removed.
 *
 * An event the tree cannot place, because it names a channel or a sibling the
 * tree does not hold, puts the channel at the end of its parent (the top level
 * when the parent is unknown) rather than losing it, and `consistent` turns
 * false and stays false. The tree then no longer mirrors the server for
 * certain; building a new one from a fresh listing with `ChannelTree.from`
 * does.
 *
 * To follow a server through a ServerQuery connection, build the tree from
 * `listChannels` and apply the four channel events to it, each with its own method.
 */
export class ChannelTree {
  readonly #channels: ReadonlyMap<ChannelID, Channel>;
  readonly #kids: ReadonlyMap<ChannelID, readonly ChannelID[]>;
  readonly #consistent: boolean;

  private constructor(draft: Draft) {
    this.#channels = draft.channels;
    this.#kids = draft.kids;
    this.#consistent = draft.consistent;
  }

  /**
   * A tree of `channels`, which may come in any order: the voice protocol's
   * welcome sends the ancestors of the client's own channel first. Siblings
   * are ordered by the `order` they name. A set that cannot be a tree, with a
   * channel twice, a parent or a predecessor missing, or a loop, is built
   * anyway and is not `consistent`.
   */
  static from(channels: Iterable<Channel>): ChannelTree {
    const draft: Draft = { channels: new Map(), kids: new Map(), consistent: true };
    const rows: Channel[] = [];
    for (const channel of channels) {
      // No channel has id 0: it is the name of the top level.
      if (channel.id === TOP) {
        draft.consistent = false;
        continue;
      }
      if (draft.channels.has(channel.id)) {
        draft.consistent = false;
        rows[rows.findIndex((row) => row.id === channel.id)] = channel;
      } else {
        rows.push(channel);
      }
      draft.channels.set(channel.id, channel);
    }

    // A parent that is not in the set, or is the channel itself, leaves a
    // channel the server did not describe properly: it goes to the top level.
    const byParent = new Map<ChannelID, Channel[]>();
    for (const channel of rows) {
      let parent = channel.parentID;
      if (parent !== TOP && (parent === channel.id || !draft.channels.has(parent))) {
        draft.consistent = false;
        parent = TOP;
        draft.channels.set(channel.id, { ...channel, parentID: TOP });
      }
      const siblings = byParent.get(parent);
      if (siblings === undefined) byParent.set(parent, [channel]);
      else siblings.push(channel);
    }
    for (const [parent, siblings] of byParent) {
      draft.kids.set(parent, sortSiblings(siblings, draft));
    }

    // Channels that are their own ancestors are reachable from no top-level
    // channel: hang each at the top, in input order, until every one is.
    const reachable = new Set<ChannelID>();
    const mark = (parent: ChannelID): void => {
      for (const id of draft.kids.get(parent) ?? []) {
        if (reachable.has(id)) continue;
        reachable.add(id);
        mark(id);
      }
    };
    mark(TOP);
    for (const row of rows) {
      if (reachable.has(row.id)) continue;
      draft.consistent = false;
      const channel = draft.channels.get(row.id)!;
      const old = draft.kids.get(channel.parentID)!.filter((id) => id !== channel.id);
      draft.kids.set(channel.parentID, old);
      draft.kids.set(TOP, [...(draft.kids.get(TOP) ?? []), channel.id]);
      draft.channels.set(channel.id, { ...channel, parentID: TOP });
      reachable.add(channel.id);
      mark(channel.id);
    }

    for (const [parent, list] of draft.kids) {
      if (list.length === 0) draft.kids.delete(parent);
      else settle(draft, list);
    }
    return new ChannelTree(draft);
  }

  /** How many channels the tree holds. */
  get size(): number {
    return this.#channels.size;
  }

  /**
   * Whether the rows were a tree and every event so far could be placed. Once
   * false it stays false.
   */
  get consistent(): boolean {
    return this.#consistent;
  }

  /** The channel, or `undefined` for one the tree does not hold. */
  get(id: ChannelID): Channel | undefined {
    return this.#channels.get(id);
  }

  /**
   * The channels directly under `parent`, in sibling order; the top level for
   * `undefined` or 0. Empty for an id the tree does not hold. A new array
   * each call.
   */
  children(parent: ChannelID = TOP): readonly Channel[] {
    const ids = this.#kids.get(parent) ?? [];
    return ids.map((id) => this.#channels.get(id)!);
  }

  /**
   * The channel and its ancestors, root first, so the channel is last. Empty
   * for an id the tree does not hold. A new array each call.
   */
  path(id: ChannelID): readonly Channel[] {
    const out: Channel[] = [];
    let channel = this.#channels.get(id);
    while (channel !== undefined && out.length <= this.#channels.size) {
      out.unshift(channel);
      channel = this.#channels.get(channel.parentID);
    }
    return out;
  }

  /**
   * The tree after a channel is created, which goes after the sibling that
   * `changes.order` names. The tree it is called on is untouched, as it is by
   * the three methods below; so is an event without a channel, which only
   * makes the tree inconsistent.
   */
  applyCreated(event: ChannelCreatedEvent): ChannelTree {
    return this.#change(event.channelID, (draft) => create(draft, event));
  }

  /**
   * The tree after a channel is edited. An edit that carries `changes.order`
   * is a move within the parent; the parent and the order are otherwise the
   * tree's to keep.
   */
  applyEdited(event: ChannelEditedEvent): ChannelTree {
    return this.#change(event.channelID, (draft) => edit(draft, event));
  }

  /** The tree after a channel moves, with its subchannels, to a place under `parentID`. */
  applyMoved(event: ChannelMovedEvent): ChannelTree {
    return this.#change(event.channelID, (draft) => move(draft, event));
  }

  /** The tree after a channel is deleted. */
  applyDeleted(event: ChannelDeletedEvent): ChannelTree {
    return this.#change(event.channelID, (draft) => remove(draft, event.channelID));
  }

  #change(channelID: ChannelID, change: (draft: Draft) => void): ChannelTree {
    const draft: Draft = {
      channels: new Map(this.#channels),
      kids: new Map([...this.#kids].map(([parent, list]) => [parent, [...list]])),
      consistent: this.#consistent,
    };
    if (channelID === TOP) draft.consistent = false;
    else change(draft);
    return new ChannelTree(draft);
  }
}

/**
 * Order siblings by the predecessor each names. Any that cannot be reached
 * from a first one (a missing, repeated or looping predecessor) follow, in
 * input order, and the set is no longer consistent.
 */
function sortSiblings(siblings: readonly Channel[], draft: Draft): ChannelID[] {
  const ids = new Set(siblings.map((channel) => channel.id));
  const after = new Map<ChannelID, Channel[]>();
  for (const channel of siblings) {
    const named = channel.order !== TOP && ids.has(channel.order);
    if (channel.order !== TOP && !named) draft.consistent = false;
    const key = named ? channel.order : TOP;
    const list = after.get(key);
    if (list === undefined) after.set(key, [channel]);
    else list.push(channel);
  }
  const out: ChannelID[] = [];
  const seen = new Set<ChannelID>();
  // Depth first, one frame per channel on the current chain, on an explicit
  // stack: a parent may hold thousands of siblings, one after the other.
  const follow = (start: ChannelID): void => {
    const stack: Array<{ readonly list: readonly Channel[]; at: number }> = [];
    const enter = (from: ChannelID): void => {
      const list = after.get(from) ?? [];
      if (list.length > 1) draft.consistent = false;
      stack.push({ list, at: 0 });
    };
    enter(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const channel = frame.list[frame.at++];
      if (channel === undefined) {
        stack.pop();
      } else if (!seen.has(channel.id)) {
        seen.add(channel.id);
        out.push(channel.id);
        enter(channel.id);
      }
    }
  };
  follow(TOP);
  for (const channel of siblings) {
    if (seen.has(channel.id)) continue;
    draft.consistent = false;
    seen.add(channel.id);
    out.push(channel.id);
    follow(channel.id);
  }
  return out;
}

/** Give every channel in `list` the `order` its position implies. */
function settle(draft: Draft, list: readonly ChannelID[]): void {
  list.forEach((id, index) => {
    const channel = draft.channels.get(id)!;
    const order = index === 0 ? TOP : list[index - 1]!;
    if (channel.order !== order) draft.channels.set(id, { ...channel, order });
  });
}

/**
 * Put `id` under `parent` after `after` (0 for first). A predecessor that is
 * not there, or none, puts it at the end.
 */
function insert(
  draft: Draft,
  parent: ChannelID,
  id: ChannelID,
  after: ChannelID | undefined,
): void {
  const list = draft.kids.get(parent) ?? [];
  let at = list.length;
  if (after === TOP) {
    at = 0;
  } else {
    const index = after === undefined ? -1 : list.indexOf(after);
    if (index >= 0) at = index + 1;
    else draft.consistent = false;
  }
  const next = [...list.slice(0, at), id, ...list.slice(at)];
  draft.kids.set(parent, next);
  settle(draft, next);
}

/** Take `id` out of its parent's list, and settle the siblings behind it. */
function detach(draft: Draft, id: ChannelID): void {
  const channel = draft.channels.get(id)!;
  const list = draft.kids.get(channel.parentID);
  if (list === undefined) return;
  const next = list.filter((sibling) => sibling !== id);
  if (next.length === 0) {
    draft.kids.delete(channel.parentID);
  } else {
    draft.kids.set(channel.parentID, next);
    settle(draft, next);
  }
}

/** Whether `id` is `ancestor` or sits below it. */
function isWithin(draft: Draft, id: ChannelID, ancestor: ChannelID): boolean {
  for (let at = draft.channels.get(id); at !== undefined; at = draft.channels.get(at.parentID)) {
    if (at.id === ancestor) return true;
  }
  return false;
}

/** The parent an event names, or the top level, and a flaw, when the tree has no such channel. */
function parentOf(draft: Draft, parent: ChannelID): ChannelID {
  if (parent === TOP || draft.channels.has(parent)) return parent;
  draft.consistent = false;
  return TOP;
}

function create(draft: Draft, event: ChannelCreatedEvent): void {
  const { channelID, changes } = event;
  if (draft.channels.has(channelID)) {
    // Created twice: the later one replaces the earlier.
    draft.consistent = false;
    remove(draft, channelID);
  }
  const parentID = parentOf(draft, event.parentID);
  const base = parseChannel({ cid: String(channelID) });
  draft.channels.set(channelID, applyChannelChanges(base, { ...changes, parentID }));
  insert(draft, parentID, channelID, changes.order);
}

function edit(draft: Draft, event: ChannelEditedEvent): void {
  const channel = draft.channels.get(event.channelID);
  if (channel === undefined) {
    draft.consistent = false;
    return;
  }
  // The parent and the order are the tree's to keep, whatever else is edited.
  const { order } = event.changes;
  const rest: Record<string, unknown> = { ...event.changes };
  delete rest["order"];
  delete rest["parentID"];
  draft.channels.set(channel.id, applyChannelChanges(channel, rest));
  if (order === undefined) return;
  detach(draft, channel.id);
  insert(draft, channel.parentID, channel.id, order);
}

function move(draft: Draft, event: ChannelMovedEvent): void {
  const channel = draft.channels.get(event.channelID);
  if (channel === undefined) {
    draft.consistent = false;
    return;
  }
  let parentID = parentOf(draft, event.parentID);
  if (isWithin(draft, parentID, channel.id)) {
    // Under itself: the server never sends it. The channel stays in its parent.
    draft.consistent = false;
    parentID = channel.parentID;
  }
  detach(draft, channel.id);
  draft.channels.set(channel.id, { ...channel, parentID });
  insert(draft, parentID, channel.id, event.order);
}

function remove(draft: Draft, id: ChannelID): void {
  if (!draft.channels.has(id)) {
    draft.consistent = false;
    return;
  }
  detach(draft, id);
  // The server deletes the subchannels first. Any left would have no parent.
  const below = draft.kids.get(id);
  if (below !== undefined) {
    draft.consistent = false;
    for (const child of below) remove(draft, child);
  }
  draft.kids.delete(id);
  draft.channels.delete(id);
}
