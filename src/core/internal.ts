/**
 * Protocol plumbing for the modules next to the core, `client` and `query`.
 *
 * Not public API and not exported by the package: they import it by relative
 * path, so it can change in any release.
 *
 * @packageDocumentation
 */

export { isCommandName, parseCommand } from "./command/parser.js";
export { encodeRequest } from "./command/request.js";
export { buildCommandChain } from "./middleware.js";
export { buildCommand, buildCommandOrdered } from "./command/command.js";
export type { Command } from "./command/command.js";
export { clientFields, parseClient, parseClientChanges } from "./api/parse.js";
export { channelFields, parseChannel, parseChannelChanges } from "./api/command.js";
export { handleNotification } from "./notifications.js";
export type { NotificationResult } from "./notifications.js";
export { parseIconID } from "./command/ids.js";
export { responseSpec } from "./command/responses.js";
export type { ResponseSpec } from "./command/responses.js";
export { parseErrorCode, parseServerError } from "./errors.js";
export { splitCommandRows, parseUint64, parseUint16, parseInt10, sleep } from "./helpers.js";
export { jitteredDelay, resolveBackoffPolicy } from "./reconnect.js";
