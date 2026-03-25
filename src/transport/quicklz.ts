const TABLE_SIZE = 4096;

interface QlzState {
  control: number;
  sourcePos: number;
  destPos: number;
  nextHashed: number;
}

export class Qlz {
  #hashtable = new Int32Array(TABLE_SIZE);

  decompress(data: Uint8Array): Uint8Array {
    const { headerLen, decompressedSize, flags } = parseQlzHeader(data);

    const dest = new Uint8Array(decompressedSize);

    if ((flags & 0x01) === 0) {
      dest.set(data.slice(headerLen, headerLen + decompressedSize));
      return dest;
    }

    this.#hashtable.fill(0);

    const state: QlzState = {
      control: 1,
      sourcePos: headerLen,
      destPos: 0,
      nextHashed: 0,
    };

    while (this.#ensureControl(data, state)) {
      if ((state.control & 1) !== 0) {
        if (!this.#processReference(data, dest, state)) break;
      } else {
        if (this.#processLiteral(data, dest, decompressedSize, state)) break;
      }
    }

    return dest;
  }

  #ensureControl(data: Uint8Array, st: QlzState): boolean {
    if (st.control !== 1) return true;
    if (st.sourcePos + 4 > data.length) return false;
    st.control =
      (data[st.sourcePos]! |
        (data[st.sourcePos + 1]! << 8) |
        (data[st.sourcePos + 2]! << 16) |
        (data[st.sourcePos + 3]! << 24)) >>>
      0;
    st.sourcePos += 4;
    return true;
  }

  #processReference(data: Uint8Array, dest: Uint8Array, st: QlzState): boolean {
    st.control = (st.control >>> 1) >>> 0;
    if (st.sourcePos + 2 > data.length) return false;

    const b1 = data[st.sourcePos]!;
    const b2 = data[st.sourcePos + 1]!;
    st.sourcePos += 2;

    const hash = (b1 >> 4) | (b2 << 4);
    let matchlen = b1 & 0x0f;
    if (matchlen !== 0) {
      matchlen += 2;
    } else {
      if (st.sourcePos >= data.length) return false;
      matchlen = data[st.sourcePos]!;
      st.sourcePos++;
    }

    const offset = this.#hashtable[hash]!;
    for (let i = 0; i < matchlen; i++) {
      if (st.destPos < dest.length && offset + i < st.destPos) {
        dest[st.destPos] = dest[offset + i]!;
        st.destPos++;
      }
    }

    const end = st.destPos + 1 - matchlen;
    this.#updateHashtable(dest, st, end);
    st.nextHashed = st.destPos;

    return true;
  }

  #processLiteral(
    data: Uint8Array,
    dest: Uint8Array,
    decompressedSize: number,
    st: QlzState,
  ): boolean {
    const threshold = Math.max(decompressedSize, 10) - 10;
    if (st.destPos >= threshold) {
      while (st.destPos < decompressedSize) {
        if (st.control === 1) {
          st.sourcePos += 4;
          if (st.sourcePos > data.length) break;
          st.control =
            (data[st.sourcePos - 4]! |
              (data[st.sourcePos - 3]! << 8) |
              (data[st.sourcePos - 2]! << 16) |
              (data[st.sourcePos - 1]! << 24)) >>>
            0;
        }
        if (st.sourcePos >= data.length) break;
        dest[st.destPos++] = data[st.sourcePos++]!;
        st.control = (st.control >>> 1) >>> 0;
      }
      return true;
    }

    if (st.sourcePos >= data.length || st.destPos >= dest.length) return true;

    dest[st.destPos++] = data[st.sourcePos++]!;
    st.control = (st.control >>> 1) >>> 0;

    const end = Math.max(st.destPos - 2, 0);
    this.#updateHashtable(dest, st, end);
    if (st.nextHashed < end) st.nextHashed = end;

    return false;
  }

  #updateHashtable(dest: Uint8Array, st: QlzState, end: number): void {
    while (st.nextHashed < end) {
      if (st.nextHashed + 3 > dest.length) break;
      const v =
        (dest[st.nextHashed]! |
          (dest[st.nextHashed + 1]! << 8) |
          (dest[st.nextHashed + 2]! << 16)) >>>
        0;
      const hash = ((v >> 12) ^ v) & 0xfff;
      this.#hashtable[hash] = st.nextHashed;
      st.nextHashed++;
    }
  }
}

function parseQlzHeader(data: Uint8Array): {
  headerLen: number;
  decompressedSize: number;
  flags: number;
} {
  if (data.length < 3) throw new Error("QuickLZ: data too short");

  const flags = data[0]!;
  const level = (flags >> 2) & 0x03;
  if (level !== 1) throw new Error("QuickLZ: only level 1 is supported");

  const headerLen = (flags & 0x02) !== 0 ? 9 : 3;
  if (data.length < headerLen) throw new Error("QuickLZ: data too short for header");

  let decompressedSize: number;
  if ((flags & 0x02) !== 0) {
    decompressedSize = (data[5]! | (data[6]! << 8) | (data[7]! << 16) | (data[8]! << 24)) >>> 0;
  } else {
    decompressedSize = data[2]!;
  }

  return { headerLen, decompressedSize, flags };
}
