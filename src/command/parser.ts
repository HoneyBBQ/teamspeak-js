import { unescape } from "./command.js";
import type { Command } from "./command.js";

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

  const name = parts[0] ?? "";
  if (name === "") return null;

  const params: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
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
