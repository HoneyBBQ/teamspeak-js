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
  let inheritedFields = new Map<string, string>();

  for (const part of parts) {
    if (part === "") continue;

    // TeamSpeak compresses pipe-separated rows by omitting fields whose
    // values are unchanged from the previous row. This is especially
    // important for notifycliententerview, where ctid is commonly present
    // only on the first row of a batch. Keep the raw escaped tokens so the
    // command parser can still perform the single unescape pass later.
    const tokens = part.split(" ").filter(Boolean);
    const currentFields = new Set<string>();
    for (const token of tokens) currentFields.add(fieldName(token));

    const inheritedTokens: string[] = [];
    for (const [field, token] of inheritedFields) {
      if (!currentFields.has(field)) inheritedTokens.push(token);
    }

    const resolvedTokens = [...inheritedTokens, ...tokens];
    rows.push(`${name} ${resolvedTokens.join(" ")}`);

    inheritedFields = new Map<string, string>();
    for (const token of resolvedTokens) {
      inheritedFields.set(fieldName(token), token);
    }
  }
  return rows.length === 0 ? [line] : rows;
}

function fieldName(token: string): string {
  const equalIndex = token.indexOf("=");
  return equalIndex > 0 ? token.slice(0, equalIndex) : token;
}
