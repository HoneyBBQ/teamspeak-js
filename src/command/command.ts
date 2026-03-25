import type { EscapedString } from "../types.js";

const ESCAPE_MAP: [string, string][] = [
  ["\\", "\\\\"],
  ["/", "\\/"],
  [" ", "\\s"],
  ["|", "\\p"],
  ["\x07", "\\a"],
  ["\x08", "\\b"],
  ["\x0C", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\x0B", "\\v"],
];

export function escape(s: string): EscapedString {
  let result = s;
  for (const [from, to] of ESCAPE_MAP) {
    result = result.split(from).join(to);
  }
  return result as EscapedString;
}

export function unescape(s: string): string {
  // Process escape sequences in a single pass to avoid double-substitution
  let result = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      switch (next) {
        case "\\":
          result += "\\";
          i += 2;
          break;
        case "/":
          result += "/";
          i += 2;
          break;
        case "s":
          result += " ";
          i += 2;
          break;
        case "p":
          result += "|";
          i += 2;
          break;
        case "a":
          result += "\x07";
          i += 2;
          break;
        case "b":
          result += "\x08";
          i += 2;
          break;
        case "f":
          result += "\x0C";
          i += 2;
          break;
        case "n":
          result += "\n";
          i += 2;
          break;
        case "r":
          result += "\r";
          i += 2;
          break;
        case "t":
          result += "\t";
          i += 2;
          break;
        case "v":
          result += "\x0B";
          i += 2;
          break;
        default:
          result += s[i] ?? "";
          i++;
          break;
      }
    } else {
      result += s[i] ?? "";
      i++;
    }
  }
  return result;
}

export interface Command {
  name: string;
  params: Record<string, string>;
}

/** Build a TS3 command string from an unordered params map. */
export function buildCommand(cmd: string, params: Record<string, string>): string {
  const parts: string[] = [escape(cmd)];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${k}=${escape(v)}`);
  }
  return parts.join(" ");
}

/** Build a TS3 command string preserving parameter order. */
export function buildCommandOrdered(
  cmd: string,
  params: ReadonlyArray<readonly [string, string]>,
): string {
  const parts: string[] = [escape(cmd)];
  for (const [k, v] of params) {
    parts.push(`${k}=${escape(v)}`);
  }
  return parts.join(" ");
}
