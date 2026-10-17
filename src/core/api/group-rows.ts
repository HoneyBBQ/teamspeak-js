/**
 * Group list rows, read. Apart from the two modules that list and edit the
 * groups, so the voice client can read the lists the server sends of itself
 * without these being public.
 */

import { big, bool, icon, num, str } from "./command.js";
import { asChannelGroupID, asServerGroupID } from "../command/ids.js";
import type { ChannelGroup } from "./groups.js";
import type { ServerGroup } from "./server.js";

/** Read a server group from a `servergrouplist` row. */
export const parseServerGroup = (row: Record<string, string>): ServerGroup => ({
  id: asServerGroupID(big(row, "sgid")),
  name: str(row, "name"),
  type: num(row, "type"),
  iconID: icon(row, "iconid"),
  savedInDatabase: bool(row, "savedb"),
  sortID: num(row, "sortid"),
  nameMode: num(row, "namemode"),
  modifyPower: num(row, "n_modifyp"),
  memberAddPower: num(row, "n_member_addp"),
  memberRemovePower: num(row, "n_member_removep"),
});

/** Read a channel group from a `channelgrouplist` row. */
export const parseChannelGroup = (row: Record<string, string>): ChannelGroup => ({
  id: asChannelGroupID(big(row, "cgid")),
  name: str(row, "name"),
  type: num(row, "type"),
  iconID: icon(row, "iconid"),
  savedInDatabase: bool(row, "savedb"),
  sortID: num(row, "sortid"),
  nameMode: num(row, "namemode"),
  modifyPower: num(row, "n_modifyp"),
  memberAddPower: num(row, "n_member_addp"),
  memberRemovePower: num(row, "n_member_removep"),
});
