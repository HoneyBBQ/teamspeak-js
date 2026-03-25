export function parseUint64(s: string): bigint {
  if (s === "" || s === undefined) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

export function parseUint16(s: string): number {
  const v = parseInt(s, 10);
  if (isNaN(v) || v < 0 || v > 65535) return 0;
  return v;
}

export function parseInt10(s: string): number {
  const v = parseInt(s, 10);
  return isNaN(v) ? 0 : v;
}

/**
 * Reports whether `actual` equals `expected` or equals `expected` followed by
 * only digits — the pattern TeamSpeak uses when a nickname is already taken.
 */
export function isAutoNicknameMatch(expected: string, actual: string): boolean {
  if (actual === expected) return true;
  if (!actual.startsWith(expected)) return false;
  const suffix = actual.slice(expected.length);
  return /^\d+$/.test(suffix);
}

/**
 * Expand a pipe-separated multi-row TS3 command line into individual rows,
 * each prefixed with the command name.
 */
export function splitCommandRows(line: string): string[] {
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx < 0) return [line];

  const name = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1);

  if (!rest.includes("|")) return [line];

  const parts = rest.split("|");
  const rows: string[] = [];
  for (const part of parts) {
    if (part !== "") rows.push(`${name} ${part}`);
  }
  return rows.length === 0 ? [line] : rows;
}
