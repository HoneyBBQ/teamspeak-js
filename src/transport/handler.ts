import { createSocket, type Socket as UdpSocket } from "node:dgram";
import type { Crypt } from "../crypto/crypt.js";
import type { Logger } from "../types.js";
import { noopLogger } from "../types.js";
import {
  type Packet,
  PacketType,
  PacketFlags,
  packetType,
  packetFlags,
  buildC2SHeader,
  parseS2CHeader,
} from "./packet.js";
import { GenerationWindow } from "./generation-window.js";
import { Qlz } from "./quicklz.js";
import { processInit1 } from "../handshake/crypt-handshake.js";

const MAX_OUT_PACKET_SIZE = 500;
const RECEIVE_PACKET_WINDOW_SIZE = 1024;
const PING_INTERVAL_MS = 5_000;
const PACKET_TIMEOUT_MS = 60_000;
const MAX_RETRY_INTERVAL_MS = 1_000;
const UDP_READ_BUFFER_SIZE = 4096;
const HEADER_SIZE = 5;
const TAG_SIZE = 8;
const VOICE_HEADER_SIZE = 3;
const RESEND_BASE_INTERVAL_MS = 500;
const RESEND_LOOP_INTERVAL_MS = 100;

interface ResendPacket {
  packet: Packet;
  firstSend: number;
  lastSend: number;
  retryCount: number;
  nextInterval: number;
}

export class PacketHandler {
  onPacket: ((p: Packet) => void) | null = null;
  onClosed: ((err: Error | null) => void) | null = null;

  readonly #crypt: Crypt;
  readonly #logger: Logger;

  #conn: UdpSocket | null = null;
  #clientID = 0;
  #closed = false;
  #stopPing: (() => void) | null = null;
  #stopResend: (() => void) | null = null;
  #lastMessageReceived = Date.now();

  #packetCounter = new Uint16Array(9);
  #generationCounter = new Uint32Array(9);

  #recvWindowCommand = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);
  #recvWindowCommandLow = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);
  #sendWindowCommand = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);
  #sendWindowCommandLow = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);

  #commandQueue = new Map<number, Packet>();
  #commandLowQueue = new Map<number, Packet>();
  #ackManager = new Map<number, ResendPacket>();
  #initPacketCheck: ResendPacket | null = null;

  constructor(crypt: Crypt, logger: Logger = noopLogger) {
    this.#crypt = crypt;
    this.#logger = logger;
  }

  setClientID(id: number): void {
    this.#clientID = id;
  }

  connect(addr: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const [host, portStr] =
        addr.lastIndexOf(":") > 0
          ? [addr.slice(0, addr.lastIndexOf(":")), addr.slice(addr.lastIndexOf(":") + 1)]
          : [addr, "9987"];
      const port = parseInt(portStr, 10);

      const socket = createSocket("udp4");
      socket.once("error", reject);
      socket.connect(port, host, () => {
        socket.off("error", reject);
        this.start(socket);
        resolve();
      });
    });
  }

  start(conn: UdpSocket): void {
    this.#conn = conn;
    this.#closed = false;
    this.#lastMessageReceived = Date.now();

    conn.on("message", (msg) => {
      this.#lastMessageReceived = Date.now();
      this.#handleRawPacket(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
    });
    conn.on("error", (err) => {
      this.#logger.error("udp error", err);
      this.#triggerClose(err);
    });
    conn.on("close", () => this.#triggerClose(null));

    this.#packetCounter[PacketType.Command] = 1;
    this.#packetCounter[PacketType.Init1] = 101;

    const init1Data = processInit1(this.#crypt, null);
    if (init1Data) this.#sendPacketRaw(PacketType.Init1, init1Data, 0);

    // Ping loop
    const pingTimer = setInterval(() => {
      if (this.#crypt.cryptoInitComplete) {
        this.sendPacket(PacketType.Ping, new Uint8Array(0), PacketFlags.Unencrypted);
      }
    }, PING_INTERVAL_MS);
    this.#stopPing = () => clearInterval(pingTimer);

    // Resend loop
    const resendTimer = setInterval(() => this.#checkResends(), RESEND_LOOP_INTERVAL_MS);
    this.#stopResend = () => clearInterval(resendTimer);
  }

  receivedFinalInitAck(): void {
    this.#initPacketCheck = null;
  }

  sendPacket(pType: PacketType, data: Uint8Array, flags: number): void {
    const dummy = !this.#crypt.cryptoInitComplete;
    if (data.length > 487 && pType !== PacketType.Voice && pType !== PacketType.VoiceWhisper) {
      this.#sendSplitPacket(pType, data, flags, dummy);
      return;
    }
    this.#sendPacketRaw(pType, data, flags, dummy);
  }

  sendVoicePacket(data: Uint8Array, codec: number): void {
    const pID = this.#packetCounter[PacketType.Voice]!;
    const pGen = this.#generationCounter[PacketType.Voice]!;
    this.#packetCounter[PacketType.Voice] = (pID + 1) & 0xffff;
    if (this.#packetCounter[PacketType.Voice] === 0) {
      this.#generationCounter[PacketType.Voice]!++;
    }

    const payloadLen = VOICE_HEADER_SIZE + data.length;
    const voicePayload = new Uint8Array(payloadLen);
    new DataView(voicePayload.buffer).setUint16(0, pID, false);
    voicePayload[2] = codec;
    voicePayload.set(data, VOICE_HEADER_SIZE);

    const p: Packet = {
      typeFlagged: PacketType.Voice | PacketFlags.Unencrypted,
      id: pID,
      clientID: this.#clientID,
      generationID: pGen,
      data: voicePayload,
      receivedAt: 0,
    };

    const header = buildC2SHeader(p);
    const final = new Uint8Array(TAG_SIZE + HEADER_SIZE + payloadLen);
    final.set(this.#crypt.fakeSignature, 0);
    final.set(header, TAG_SIZE);
    final.set(voicePayload, TAG_SIZE + HEADER_SIZE);
    this.#write(final);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopPing?.();
    this.#stopResend?.();
    this.#conn?.close();
  }

  // ---- Private ---------------------------------------------------------------

  #sendSplitPacket(pType: PacketType, data: Uint8Array, flags: number, dummy: boolean): void {
    const maxSize = MAX_OUT_PACKET_SIZE - HEADER_SIZE - TAG_SIZE; // 487
    let pos = 0;
    let first = true;

    while (pos < data.length) {
      const blockSize = Math.min(data.length - pos, maxSize);
      const last = pos + blockSize === data.length;

      let pFlags = flags;
      if (first !== last) pFlags |= PacketFlags.Fragmented;

      this.#sendPacketRaw(pType, data.slice(pos, pos + blockSize), pFlags, dummy);
      pos += blockSize;
      first = false;
    }
  }

  #sendPacketRaw(
    pType: PacketType,
    data: Uint8Array,
    flags: number,
    dummy = !this.#crypt.cryptoInitComplete,
  ): void {
    flags = applyProtocolFlags(pType, flags);
    const [pID, pGen] = this.#nextPacketIdentity(pType);

    const p: Packet = {
      typeFlagged: pType | flags,
      id: pID,
      clientID: this.#clientID,
      generationID: pGen,
      data,
      receivedAt: 0,
    };

    const unencrypted = (flags & PacketFlags.Unencrypted) !== 0;
    const header = buildC2SHeader(p);
    const [ciphertext, tag] = this.#crypt.encrypt(
      pType,
      pID,
      pGen,
      header,
      data,
      dummy,
      unencrypted,
    );

    const final = new Uint8Array(TAG_SIZE + HEADER_SIZE + ciphertext.length);
    final.set(tag.slice(0, TAG_SIZE), 0);
    final.set(header, TAG_SIZE);
    final.set(ciphertext, TAG_SIZE + HEADER_SIZE);
    this.#write(final);

    const rp: ResendPacket = {
      packet: p,
      firstSend: Date.now(),
      lastSend: Date.now(),
      retryCount: 0,
      nextInterval: RESEND_BASE_INTERVAL_MS,
    };
    this.#trackResend(pType, p, rp);
  }

  #write(data: Uint8Array): void {
    this.#conn?.send(Buffer.from(data), (err) => {
      if (err) this.#logger.warn("udp send error", err);
    });
  }

  #handleRawPacket(raw: Uint8Array): void {
    if (raw.length < 11) return;

    const tag = raw.slice(0, TAG_SIZE);
    const header = raw.slice(TAG_SIZE, TAG_SIZE + 3);
    const ciphertext = raw.slice(TAG_SIZE + 3);

    const parsed = parseS2CHeader(header);
    const p: Packet = {
      ...parsed,
      clientID: 0,
      generationID: this.#resolveGeneration(parsed.id, parsed.typeFlagged & 0x0f),
      data: new Uint8Array(0),
      receivedAt: Date.now(),
    };

    const decrypted = this.#decryptPacketData(p, header, ciphertext, tag);
    if (decrypted === null) return;
    p.data = decrypted.plaintext;

    const pType = packetType(p);

    if (pType === PacketType.Ping) {
      this.#sendPong(p.id, decrypted.dummyUsed);
      return;
    }

    if (!this.#handleCommandWindowAndAck(p, decrypted.dummyUsed)) return;

    this.#handlePacketQueue(p);
    this.#updatePostReceiveState(p);
  }

  #resolveGeneration(id: number, pType: number): number {
    switch (pType as PacketType) {
      case PacketType.Command:
        return this.#recvWindowCommand.getGeneration(id);
      case PacketType.CommandLow:
        return this.#recvWindowCommandLow.getGeneration(id);
      case PacketType.Ack:
        return this.#sendWindowCommand.getGeneration(id);
      case PacketType.AckLow:
        return this.#sendWindowCommandLow.getGeneration(id);
      default:
        return 0;
    }
  }

  #decryptPacketData(
    p: Packet,
    header: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
  ): { plaintext: Uint8Array; dummyUsed: boolean } | null {
    const unencrypted = (packetFlags(p) & PacketFlags.Unencrypted) !== 0;
    const dummy = !this.#crypt.cryptoInitComplete;
    let dummyUsed = dummy;
    const pType = packetType(p);
    const gen = p.generationID;

    try {
      const plaintext = this.#crypt.decrypt(
        pType,
        p.id,
        gen,
        header,
        ciphertext,
        tag,
        dummy,
        unencrypted,
      );
      return { plaintext, dummyUsed };
    } catch {
      // Try adjacent generations
      for (const offset of [-1, 1]) {
        const guessGen = gen + offset;
        if (guessGen < 0) continue;
        try {
          const plaintext = this.#crypt.decrypt(
            pType,
            p.id,
            guessGen,
            header,
            ciphertext,
            tag,
            false,
            false,
          );
          return { plaintext, dummyUsed: false };
        } catch {
          // continue
        }
      }

      // Try dummy fallback for command/ack types
      if (
        pType === PacketType.Command ||
        pType === PacketType.CommandLow ||
        pType === PacketType.Ack
      ) {
        try {
          const plaintext = this.#crypt.decrypt(
            pType,
            p.id,
            gen,
            header,
            ciphertext,
            tag,
            true,
            unencrypted,
          );
          return { plaintext, dummyUsed: true };
        } catch {
          // fall through
        }
      }

      this.#logger.debug("packet decryption failed", { type: pType, id: p.id });
      return null;
    }
  }

  #handleCommandWindowAndAck(p: Packet, dummyUsed: boolean): boolean {
    const pType = packetType(p);
    if (pType !== PacketType.Command && pType !== PacketType.CommandLow) return true;

    const win = pType === PacketType.Command ? this.#recvWindowCommand : this.#recvWindowCommandLow;
    const ackType = pType === PacketType.Command ? PacketType.Ack : PacketType.AckLow;

    if (!win.isInWindow(p.id)) {
      if (win.isOldPacket(p.id)) {
        this.#sendAck(p.id, ackType, dummyUsed);
      }
      return false;
    }
    this.#sendAck(p.id, ackType, dummyUsed);
    return true;
  }

  #sendAck(packetID: number, ackType: PacketType, dummyUsed: boolean): void {
    const ackData = new Uint8Array(2);
    new DataView(ackData.buffer).setUint16(0, packetID, false);
    this.#sendPacketRaw(ackType, ackData, 0, dummyUsed);
  }

  #sendPong(pID: number, dummyUsed: boolean): void {
    const pongData = new Uint8Array(2);
    new DataView(pongData.buffer).setUint16(0, pID, false);
    this.#sendPacketRaw(PacketType.Pong, pongData, PacketFlags.Unencrypted, dummyUsed);
  }

  #handlePacketQueue(p: Packet): void {
    const pType = packetType(p);
    if (pType !== PacketType.Command && pType !== PacketType.CommandLow) {
      this.onPacket?.(p);
      return;
    }

    const isCommand = pType === PacketType.Command;
    const queue = isCommand ? this.#commandQueue : this.#commandLowQueue;
    const win = isCommand ? this.#recvWindowCommand : this.#recvWindowCommandLow;

    queue.set(p.id, p);

    if (isCommand) {
      this.#fastForwardMissingPackets(queue, win, true);
    } else {
      this.#fastForwardMissingPackets(queue, win, false);
    }

    while (true) {
      const current = isCommand ? this.#_nextCommandID : this.#_nextCommandLowID;
      const packet = queue.get(current);
      if (packet === undefined) break;

      const result = this.#tryReassemble(packet, queue, current, win);
      if (!result) break;

      const [reassembled, newNext] = result;
      if (isCommand) this.#_nextCommandID = newNext;
      else this.#_nextCommandLowID = newNext;

      this.#tryDecompress(reassembled);
      this.onPacket?.(reassembled);
    }
  }

  #_nextCommandID = 0;
  #_nextCommandLowID = 0;

  #fastForwardMissingPackets(
    queue: Map<number, Packet>,
    win: GenerationWindow,
    isCommand: boolean,
  ): void {
    let nextID = isCommand ? this.#_nextCommandID : this.#_nextCommandLowID;
    while (!queue.has(nextID) && hasOldNewerPacket(queue, nextID)) {
      nextID = (nextID + 1) & 0xffff;
      win.advance(1);
    }
    if (isCommand) this.#_nextCommandID = nextID;
    else this.#_nextCommandLowID = nextID;
  }

  #tryReassemble(
    startPacket: Packet,
    queue: Map<number, Packet>,
    nextID: number,
    win: GenerationWindow,
  ): [reassembled: Packet, newNextID: number] | null {
    if ((packetFlags(startPacket) & PacketFlags.Fragmented) === 0) {
      queue.delete(nextID);
      win.advance(1);
      return [startPacket, (nextID + 1) & 0xffff];
    }

    const fragments: Packet[] = [];
    let totalSize = 0;
    let currID = nextID;
    let startSeen = false;
    let complete = false;

    while (true) {
      const frag = queue.get(currID);
      if (!frag) return null;
      fragments.push(frag);
      totalSize += frag.data.length;

      const fragmented = (packetFlags(frag) & PacketFlags.Fragmented) !== 0;
      if (!startSeen) {
        startSeen = true;
        if (!fragmented) {
          complete = true;
          break;
        }
      } else if (fragmented) {
        complete = true;
        break;
      }
      currID = (currID + 1) & 0xffff;
    }

    if (!complete) return null;

    const combined = new Uint8Array(totalSize);
    let pos = 0;
    for (const frag of fragments) {
      combined.set(frag.data, pos);
      pos += frag.data.length;
      queue.delete(nextID);
      win.advance(1);
      nextID = (nextID + 1) & 0xffff;
    }

    startPacket.data = combined;
    startPacket.typeFlagged &= ~PacketFlags.Fragmented;
    return [startPacket, nextID];
  }

  #tryDecompress(packet: Packet): void {
    if ((packetFlags(packet) & PacketFlags.Compressed) === 0) return;
    try {
      const qlz = new Qlz();
      packet.data = qlz.decompress(packet.data);
      packet.typeFlagged &= ~PacketFlags.Compressed;
    } catch (err) {
      this.#logger.debug("decompression failed", { id: packet.id, err });
    }
  }

  #updatePostReceiveState(p: Packet): void {
    const pType = packetType(p);

    if (pType === PacketType.Init1) {
      this.#initPacketCheck = null;
      return;
    }

    if ((pType === PacketType.Ack || pType === PacketType.AckLow) && p.data.length >= 2) {
      const ackID = new DataView(p.data.buffer, p.data.byteOffset).getUint16(0, false);
      const targetType = pType === PacketType.Ack ? PacketType.Command : PacketType.CommandLow;
      const key = (targetType << 16) | ackID;
      this.#ackManager.delete(key);
    }
  }

  #nextPacketIdentity(pType: PacketType): [id: number, gen: number] {
    const pID = this.#packetCounter[pType]!;
    const pGen = this.#generationCounter[pType]!;

    if (pType === PacketType.Init1) return [pID, pGen];

    this.#packetCounter[pType] = (pID + 1) & 0xffff;
    if (this.#packetCounter[pType] === 0) {
      this.#generationCounter[pType] = (pGen + 1) >>> 0;
    }

    if (pType === PacketType.Command) {
      this.#sendWindowCommand.advanceToExcluded(pID);
    } else if (pType === PacketType.CommandLow) {
      this.#sendWindowCommandLow.advanceToExcluded(pID);
    }

    return [pID, pGen];
  }

  #trackResend(pType: PacketType, p: Packet, rp: ResendPacket): void {
    if (pType === PacketType.Init1) {
      this.#initPacketCheck = rp;
      return;
    }
    if (pType === PacketType.Command || pType === PacketType.CommandLow) {
      const key = (pType << 16) | p.id;
      this.#ackManager.set(key, rp);
    }
  }

  #checkResends(): void {
    const now = Date.now();

    if (now - this.#lastMessageReceived > PACKET_TIMEOUT_MS) {
      this.#logger.warn("idle timeout");
      this.#triggerClose(new Error("idle timeout"));
      return;
    }

    if (this.#initPacketCheck) {
      this.#doResend(this.#initPacketCheck, now);
    }

    for (const [key, rp] of this.#ackManager) {
      if (now - rp.firstSend > PACKET_TIMEOUT_MS) {
        this.#ackManager.delete(key);
        this.#triggerClose(new Error("packet ack timeout"));
        return;
      }
      this.#doResend(rp, now);
    }
  }

  #doResend(rp: ResendPacket, now: number): void {
    if (now - rp.lastSend < rp.nextInterval) return;

    rp.lastSend = now;
    rp.retryCount++;
    rp.nextInterval = Math.min(rp.nextInterval * 2, MAX_RETRY_INTERVAL_MS);

    const dummy = !this.#crypt.cryptoInitComplete;
    const unencrypted = (packetFlags(rp.packet) & PacketFlags.Unencrypted) !== 0;
    const header = buildC2SHeader(rp.packet);
    const pType = packetType(rp.packet);

    const [ciphertext, tag] = this.#crypt.encrypt(
      pType,
      rp.packet.id,
      rp.packet.generationID,
      header,
      rp.packet.data,
      dummy,
      unencrypted,
    );

    const final = new Uint8Array(TAG_SIZE + HEADER_SIZE + ciphertext.length);
    final.set(tag.slice(0, TAG_SIZE), 0);
    final.set(header, TAG_SIZE);
    final.set(ciphertext, TAG_SIZE + HEADER_SIZE);
    this.#write(final);
  }

  #triggerClose(err: Error | null): void {
    if (this.#closed) return;
    this.close();
    this.onClosed?.(err);
  }
}

// ---- Helpers ----------------------------------------------------------------

function applyProtocolFlags(pType: PacketType, flags: number): number {
  if (pType === PacketType.Command || pType === PacketType.CommandLow) {
    return flags | PacketFlags.NewProtocol;
  }
  return flags;
}

function hasOldNewerPacket(queue: Map<number, Packet>, nextID: number): boolean {
  const now = Date.now();
  for (const [id, pkg] of queue) {
    const diff = (id - nextID + 0x10000) & 0xffff;
    if (diff < 0x8000 && now - pkg.receivedAt > 5_000) {
      return true;
    }
  }
  return false;
}
