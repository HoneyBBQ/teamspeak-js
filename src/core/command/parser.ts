import { unescape } from "./command.js";
import type { Command } from "./command.js";

/**
 * Whether a token is a command name.
 *
 * A command name is a run of ASCII alphanumerics and underscores. TeamSpeak 3
 * names have no underscore, but TeamSpeak 6 names some with one: its S3 file
 * transfer commands (`s3ft_getpresignedurl`) and the notifications answering
 * them (`notify_presigned_urls`). Everything that splits or parses a line asks
 * this one function, so the parser and the row splitter cannot disagree about
 * where a command's data begins.
 */
export function isCommandName(token: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(token);
}

/**
 * Parse one command line, or one row of it. Returns null for an empty line.
 * A line whose first token is not a command name is a data row, with `name`
 * `""`.
 */
export function parseCommand(s: string): Command | null {
  if (s === "") return null;

  // Skip leading non-printable bytes (< 0x20 or > 0x7E)
  let startIndex = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 32 && code <= 126) {
      startIndex = i;
      break;
    }
  }
  if (startIndex > 0) {
    s = s.slice(startIndex);
  }

  const parts = s.split(" ");
  if (parts.length === 0) return null;

  // A command name is a run of alphanumerics and underscores followed by a
  // space (see isCommandName). Anything else means the line is not a command at
  // all: response rows carry no name ("clid=6 cid=2 ..."),
  // and negative feedback is "-1 id=2 ...", naming the *rejected* command id
  // rather than a command of its own. Returning those as a nameless row keeps
  // the data intact instead of folding the first field into a name, which is
  // how a clientlist row used to arrive as name="clid=6" and lose its clid.
  const first = parts[0] ?? "";
  if (first === "") return null;

  // No prototype: a key is whatever the line says, and one named __proto__
  // must be stored, not swallowed by Object.prototype's setter.
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  const name = isCommandName(first) ? first : "";
  const start = name === "" ? 0 : 1;

  for (let i = start; i < parts.length; i++) {
    const p = parts[i];
    if (p === undefined || p === "") continue;
    const eqIdx = p.indexOf("=");
    if (eqIdx >= 0) {
      params[unescape(p.slice(0, eqIdx))] = unescape(p.slice(eqIdx + 1));
    } else {
      params[unescape(p)] = "";
    }
  }

  return { name, params };
}
