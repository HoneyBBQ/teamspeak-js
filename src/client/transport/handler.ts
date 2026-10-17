import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { parseConnectAddress } from "../address.js";
import type { Crypt } from "../crypto/crypt.js";
import type { DatagramSocket, SocketFactory } from "../types.js";
import type { Logger } from "@honeybbq/teamspeak";
import { noopLogger } from "@honeybbq/teamspeak";
import {
  type Packet,
  PacketType,
  PacketFlags,
  packetType,
  packetFlags,
  buildC2SHeader,
  parseS2CHeader,
} from "./packet.js";
import { ConnectionTimeoutError } from "../errors.js";
import { abortable, abortReason } from "../abort.js";
import { NotConnectedError, TeamspeakError } from "@honeybbq/teamspeak";
import { GenerationWindow } from "./generation-window.js";
import { Qlz } from "./quicklz.js";
import { RoundTripEstimator, TrafficMeter, type TrafficSnapshot } from "./traffic.js";
import { processInit1 } from "../handshake/crypt-handshake.js";

const MAX_OUT_PACKET_SIZE = 500;
const RECEIVE_PACKET_WINDOW_SIZE = 1024;
const PING_INTERVAL_MS = 5_000;
const PACKET_TIMEOUT_MS = 60_000;
const MAX_RETRY_INTERVAL_MS = 1_000;
const HEADER_SIZE = 5;
const TAG_SIZE = 8;
const VOICE_HEADER_SIZE = 3;
const WHISPER_HEADER_SIZE = 5;
const GROUP_WHISPER_HEADER_SIZE = 13;
const RESEND_BASE_INTERVAL_MS = 500;
const RESEND_LOOP_INTERVAL_MS = 100;

/**
 * The largest command reassembled from fragments. The receive window already
 * bounds how many fragments one command can span; this bounds their total
 * size, which a datagram's own size limit would otherwise let reach tens of
 * megabytes.
 */
const MAX_REASSEMBLED_SIZE = 1 << 20;

/**
 * The largest datagram taken. TeamSpeak's packets are at most 500 bytes; a
 * larger one is no packet of the protocol's, and is dropped before anything
 * is decrypted or held.
 */
export const MAX_DATAGRAM_SIZE: number = 4096;

/**
 * The most command bytes held, across both receive queues, waiting for the
 * packets before them. A server's in-order traffic drains at once and a full
 * window of real packets is under a megabyte; past this, a packet is dropped
 * unacknowledged, so the server sends it again once there is room.
 */
export const MAX_QUEUED_BYTES: number = 1 << 20;

/**
 * The packet types the server may send unencrypted: voice, which TeamSpeak
 * never encrypts, ping and pong, and acknowledgements — TS3 3.13 and TS6 6.0
 * both acknowledge commands with plaintext Acks once crypto init has
 * completed. An Ack carries nothing but the id it acknowledges, so a forged
 * one can at worst stop a resend, which dropping the packet would do too.
 * Init1 is handled before decryption.
 */
const UNENCRYPTED_TYPES: ReadonlySet<number> = new Set<number>([
  PacketType.Voice,
  PacketType.VoiceWhisper,
  PacketType.Ping,
  PacketType.Pong,
  PacketType.Ack,
  PacketType.AckLow,
  PacketType.Init1,
]);

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
  /**
   * A received datagram could not be handled: it was malformed, or handling it
   * threw. The datagram is dropped either way; the owner decides whether that
   * ends the connection. Without an owner the error is logged.
   */
  onReceiveError: ((error: unknown) => void) | null = null;
  /** Called with the socket once it is open, before the handshake's first packet is sent. */
  onOpen: ((socket: DatagramSocket) => void) | null = null;

  readonly #crypt: Crypt;
  readonly #logger: Logger;
  readonly #socketFactory: SocketFactory | undefined;

  #conn: DatagramSocket | null = null;
  #clientID = 0;
  #closed = false;
  #stopPing: (() => void) | null = null;
  #stopResend: (() => void) | null = null;
  #lastMessageReceived = performance.now();
  readonly #traffic = new TrafficMeter();
  readonly #roundTrip = new RoundTripEstimator();
  /** When each keepalive ping still waiting for its pong was sent, by packet id. */
  readonly #pingsSent = new Map<number, number>();

  #packetCounter = new Uint16Array(9);
  #generationCounter = new Uint32Array(9);

  #recvWindowCommand = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);
  #recvWindowCommandLow = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);
  #sendWindowCommand = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);
  #sendWindowCommandLow = new GenerationWindow(1 << 16, RECEIVE_PACKET_WINDOW_SIZE);

  #commandQueue = new Map<number, Packet>();
  #commandLowQueue = new Map<number, Packet>();
  /** The bytes held in both command queues; see MAX_QUEUED_BYTES. */
  #queuedBytes = 0;
  #ackManager = new Map<number, ResendPacket>();
  /**
   * The last Init1 packet the client sent, resent until the handshake's final
   * acknowledgement. Init1 packets are not acknowledged one by one: each step
   * the client sends replaces it, and only `receivedFinalInitAck` clears it.
   * Receiving an Init1 does not, as the client may have nothing to answer with.
   */
  #initPacketCheck: ResendPacket | null = null;
  /**
   * Command packets sent under the dummy key, before crypto init completed:
   * clientek, in practice. Both TS3 and TS6 acknowledge clientek under the
   * dummy key even though it completes crypto init, so the dummy key stays
   * acceptable for exactly those acknowledgements, and for nothing else.
   */
  #dummyCommandIDs = new Set<number>();
  #resends = 0;

  constructor(crypt: Crypt, logger: Logger = noopLogger, socketFactory?: SocketFactory) {
    this.#crypt = crypt;
    this.#logger = logger;
    this.#socketFactory = socketFactory;
  }

  setClientID(id: number): void {
    this.#clientID = id;
  }

  /**
   * Resolve `addr`, open a socket to it and start the handshake.
   *
   * Aborting `signal`, or closing the handler, while this runs abandons it: the
   * lookup's answer is ignored, and a socket that finishes connecting
   * afterwards is closed rather than started, so no handshake begins after
   * the connection was given up.
   */
  async connect(addr: string, signal?: AbortSignal): Promise<void> {
    const { host, portNumber } = parseConnectAddress(addr);
    this.#throwIfAbandoned(signal);

    // Resolve before choosing a socket family. `isIP()` only recognises literal
    // addresses and returns 0 for every hostname, so picking the family from it
    // sent every hostname to a udp4 socket — and a udp4 socket handed a name
    // that resolves to IPv6 drops the datagrams with no error at all. On a
    // stock macOS/Linux box `localhost` resolves to ::1 first, so that path
    // silently never connected. Let DNS decide, then match the family.
    let resolved: { address: string; family: number };
    try {
      resolved = await abortable(lookup(host), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // Wrapped, not classed as an invalid address: a lookup can fail for a
      // while (EAI_AGAIN) and then succeed, which a reconnect should retry.
      throw new TeamspeakError(`could not resolve ${host}`, { cause: error });
    }
    const { address, family } = resolved;
    this.#throwIfAbandoned(signal);

    const family6 = family === 6;
    const socket: DatagramSocket = this.#socketFactory
      ? this.#socketFactory(family6 ? 6 : 4)
      : createSocket(family6 ? "udp6" : "udp4");

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const fail = (error: unknown): void => {
        if (done) return;
        done = true;
        socket.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
        closeQuietly(socket);
        reject(error);
      };
      const onError = (error: Error): void => fail(error);
      const onAbort = (): void => fail(abortReason(signal!));
      socket.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Connect to the resolved address, not the original host, so the socket
      // cannot end up talking to a different family than it was created for.
      socket.connect(portNumber, address, () => {
        if (done) return;
        if (this.#closed || signal?.aborted) {
          fail(signal?.aborted ? abortReason(signal) : new NotConnectedError());
          return;
        }
        done = true;
        socket.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
        this.onOpen?.(socket);
        this.start(socket);
        resolve();
      });
    });
  }

  #throwIfAbandoned(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
    if (this.#closed) throw new NotConnectedError();
  }

  /** Take over a connected socket and start the handshake on it. A closed handler closes it instead. */
  start(conn: DatagramSocket): void {
    if (this.#closed) {
      closeQuietly(conn);
      return;
    }
    this.#conn = conn;
    this.#lastMessageReceived = performance.now();

    conn.on("message", (msg) => {
      if (this.#closed) return;
      // Everything here parses what the network sent. Nothing it throws may
      // escape: from a socket callback it would be an uncaught exception, and
      // a malformed datagram from the server would take the process down.
      try {
        this.#handleRawPacket(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
      } catch (error: unknown) {
        if (this.onReceiveError) this.onReceiveError(error);
        else this.#logger.debug("dropped a malformed packet", { error: String(error) });
      }
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
        const id = this.#packetCounter[PacketType.Ping]!;
        this.#pingsSent.set(id, performance.now());
        // A pong that never came must not pile up.
        if (this.#pingsSent.size > 16) this.#pingsSent.delete(this.#pingsSent.keys().next().value!);
        this.sendPacket(PacketType.Ping, new Uint8Array(0), PacketFlags.Unencrypted);
      }
    }, PING_INTERVAL_MS);
    this.#stopPing = () => clearInterval(pingTimer);

    // Resend loop
    const resendTimer = setInterval(() => this.#checkResends(), RESEND_LOOP_INTERVAL_MS);
    this.#stopResend = () => clearInterval(resendTimer);
  }

  /**
   * Stop resending the last Init1 packet the client sent. Until this is called,
   * the latest step stays pending whatever the server sends in between: a step
   * the client does not answer, an unknown one or a second RSA challenge, must
   * not stop the resending of its own. The server's `initivexpand2` command
   * acknowledges the last step, not an Init1 reply.
   */
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

  /**
   * Send an unencrypted voice whisper packet in its direct form (the
   * new-protocol flag unset): up to 255 channel ids and up to 32 client ids,
   * at least one of the two.
   */
  sendWhisperPacket(
    data: Uint8Array,
    targetClientIds: readonly number[],
    codec: number,
    targetChannelIds: readonly bigint[] = [],
  ): void {
    if (targetClientIds.length === 0 && targetChannelIds.length === 0) {
      throw new RangeError("a whisper needs at least one target");
    }
    if (targetClientIds.length > 32)
      throw new RangeError("a whisper has at most 32 client targets");
    if (targetChannelIds.length > 255) {
      throw new RangeError("a whisper has at most 255 channel targets");
    }
    if (targetClientIds.some((id) => !Number.isInteger(id) || id < 0 || id > 0xffff)) {
      throw new RangeError("invalid whisper target");
    }
    if (targetChannelIds.some((id) => id < 0n || id > 0xffff_ffff_ffff_ffffn)) {
      throw new RangeError("invalid whisper channel target");
    }

    const idsLen = targetChannelIds.length * 8 + targetClientIds.length * 2;
    const payload = new Uint8Array(WHISPER_HEADER_SIZE + idsLen + data.length);
    const view = new DataView(payload.buffer);
    payload[2] = codec;
    payload[3] = targetChannelIds.length;
    payload[4] = targetClientIds.length;
    let at = WHISPER_HEADER_SIZE;
    for (const id of targetChannelIds) {
      view.setBigUint64(at, id, false);
      at += 8;
    }
    for (const id of targetClientIds) {
      view.setUint16(at, id, false);
      at += 2;
    }
    payload.set(data, at);
    this.#sendWhisperPayload(payload, 0);
  }

  /**
   * Send an unencrypted voice whisper packet in its group form (the
   * new-protocol flag set): a group type, a target scope and one u64 id, which
   * is 0 where the type has none.
   */
  sendGroupWhisperPacket(
    data: Uint8Array,
    groupType: number,
    scope: number,
    id: bigint,
    codec: number,
  ): void {
    if (!Number.isInteger(groupType) || groupType < 0 || groupType > 0xff) {
      throw new RangeError("invalid group whisper type");
    }
    if (!Number.isInteger(scope) || scope < 0 || scope > 0xff) {
      throw new RangeError("invalid group whisper scope");
    }
    if (id < 0n || id > 0xffff_ffff_ffff_ffffn) throw new RangeError("invalid group whisper id");

    const payload = new Uint8Array(GROUP_WHISPER_HEADER_SIZE + data.length);
    const view = new DataView(payload.buffer);
    payload[2] = codec;
    payload[3] = groupType;
    payload[4] = scope;
    view.setBigUint64(5, id, false);
    payload.set(data, GROUP_WHISPER_HEADER_SIZE);
    this.#sendWhisperPayload(payload, PacketFlags.NewProtocol);
  }

  /** Number a whisper payload (bytes 0..1 are the voice id) and write it. */
  #sendWhisperPayload(payload: Uint8Array, flags: number): void {
    const pID = this.#packetCounter[PacketType.VoiceWhisper]!;
    const pGen = this.#generationCounter[PacketType.VoiceWhisper]!;
    this.#packetCounter[PacketType.VoiceWhisper] = (pID + 1) & 0xffff;
    if (this.#packetCounter[PacketType.VoiceWhisper] === 0) {
      this.#generationCounter[PacketType.VoiceWhisper] = (pGen + 1) >>> 0;
    }
    new DataView(payload.buffer).setUint16(0, pID, false);

    const packet: Packet = {
      typeFlagged: PacketType.VoiceWhisper | PacketFlags.Unencrypted | flags,
      id: pID,
      clientID: this.#clientID,
      generationID: pGen,
      data: payload,
      receivedAt: 0,
    };
    const header = buildC2SHeader(packet);
    const final = new Uint8Array(TAG_SIZE + HEADER_SIZE + payload.length);
    final.set(this.#crypt.fakeSignature, 0);
    final.set(header, TAG_SIZE);
    final.set(payload, TAG_SIZE + HEADER_SIZE);
    this.#write(final);
  }

  /** What this connection has carried so far, per direction and class. */
  trafficSnapshot(): TrafficSnapshot {
    return this.#traffic.snapshot(performance.now());
  }

  /** The keepalive round-trip time, or null before the first pong. */
  get roundTrip(): { readonly meanMs: number; readonly deviationMs: number } | null {
    return this.#roundTrip.get();
  }

  /** How many packets have been sent again for want of an acknowledgement. */
  get resends(): number {
    return this.#resends;
  }

  /** Whether there is a live socket to send on. */
  get isOpen(): boolean {
    return this.#conn !== null && !this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopPing?.();
    this.#stopResend?.();

    // The socket may already be closed — this runs from its own "close" event
    // when a connection drops — and dgram throws ERR_SOCKET_DGRAM_NOT_RUNNING
    // on a second close. Letting that escape would surface as an uncaught
    // exception inside an event callback, taking the process with it instead of
    // reporting a dropped connection.
    const conn = this.#conn;
    this.#conn = null;
    if (conn === null) return;
    try {
      conn.close();
    } catch (error: unknown) {
      this.#logger.debug("socket already closed", { error: String(error) });
    }
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
    if (dummy && pType === PacketType.Command) this.#dummyCommandIDs.add(pID);

    const rp: ResendPacket = {
      packet: p,
      firstSend: performance.now(),
      lastSend: performance.now(),
      retryCount: 0,
      nextInterval: RESEND_BASE_INTERVAL_MS,
    };
    this.#trackResend(pType, p, rp);
  }

  #write(data: Uint8Array): void {
    if (!this.#conn) return;
    if (data.length > TAG_SIZE + HEADER_SIZE - 1) {
      this.#traffic.recordSent(
        data[TAG_SIZE + HEADER_SIZE - 1]! & 0x0f,
        data.length,
        performance.now(),
      );
    }
    try {
      this.#conn.send(data, (err) => {
        if (err) this.#logger.warn("udp send error", err);
      });
    } catch (error: unknown) {
      const normalized =
        error instanceof Error ? error : new Error(String(error), { cause: error });
      // dgram can throw synchronously for an invalid family/address pair. A
      // malformed remote target must close this session, never escape from an
      // async socket callback and terminate the gateway process.
      this.#logger.error("udp send failed", normalized);
      this.#triggerClose(normalized);
    }
  }

  #handleRawPacket(raw: Uint8Array): void {
    if (raw.length < 11) return;
    if (raw.length > MAX_DATAGRAM_SIZE) {
      this.#logger.debug("dropped an oversized datagram", { size: raw.length });
      return;
    }

    const tag = raw.slice(0, TAG_SIZE);
    const header = raw.slice(TAG_SIZE, TAG_SIZE + 3);
    const ciphertext = raw.slice(TAG_SIZE + 3);

    const parsed = parseS2CHeader(header);
    this.#traffic.recordReceived(parsed.typeFlagged & 0x0f, raw.length, performance.now());
    // Init1 belongs to the start of the handshake; once crypto init has
    // completed, another one can only restart a session that is already set up.
    const parsedType: PacketType = parsed.typeFlagged & 0x0f;
    if (parsedType === PacketType.Init1 && this.#crypt.cryptoInitComplete) return;

    const p: Packet = {
      ...parsed,
      clientID: 0,
      generationID: this.#resolveGeneration(parsed.id, parsedType),
      data: new Uint8Array(0),
      receivedAt: performance.now(),
    };

    const decrypted = this.#decryptPacketData(p, header, ciphertext, tag);
    if (decrypted === null) return;
    p.data = decrypted.plaintext;
    // Only a packet that decrypted shows the server is there: anyone can send
    // datagrams that do not, and they must not keep a dead session alive.
    this.#lastMessageReceived = performance.now();

    const pType = packetType(p);

    if (pType === PacketType.Pong && p.data.length >= 2) {
      const acked = new DataView(p.data.buffer, p.data.byteOffset).getUint16(0, false);
      const sentAt = this.#pingsSent.get(acked);
      if (sentAt !== undefined) {
        this.#pingsSent.delete(acked);
        this.#roundTrip.add(p.receivedAt - sentAt);
      }
    }

    if (pType === PacketType.Ping) {
      this.#sendPong(p.id, decrypted.dummyUsed);
      return;
    }

    if (!this.#handleCommandWindowAndAck(p, decrypted.dummyUsed)) return;

    this.#handlePacketQueue(p);
    this.#updatePostReceiveState(p);
  }

  #resolveGeneration(id: number, pType: PacketType): number {
    switch (pType) {
      case PacketType.Command:
        return this.#recvWindowCommand.getGeneration(id);
      case PacketType.CommandLow:
        return this.#recvWindowCommandLow.getGeneration(id);
      case PacketType.Ack:
        return this.#sendWindowCommand.getGeneration(id);
      case PacketType.AckLow:
        return this.#sendWindowCommandLow.getGeneration(id);
      case PacketType.Voice:
      case PacketType.VoiceWhisper:
      case PacketType.Ping:
      case PacketType.Pong:
      case PacketType.Init1:
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
    const pType = packetType(p);
    const gen = p.generationID;

    // An unencrypted packet is checked against the fake signature only, and
    // that signature is no secret: every plaintext ping, pong and voice packet
    // carries it. A command must therefore never be taken unencrypted, or
    // anyone on the path could forge text messages, kicks and command answers.
    if (unencrypted && !UNENCRYPTED_TYPES.has(pType)) {
      this.#logger.debug("dropped an unencrypted packet of a type that must be encrypted", {
        type: pType,
        id: p.id,
      });
      return null;
    }

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
      return { plaintext, dummyUsed: dummy };
    } catch {
      // Before crypto init only the dummy key exists: there is no other key
      // to try.
      if (dummy) return null;
      // No other generation is tried: the receive window already places the
      // id in its generation, and a packet that decrypts only under the one
      // before is an old packet replayed after the 16-bit id wrapped. Neither
      // TS3 nor TS6 ever needed a guess at the next one.

      // The acknowledgement of a command sent under the dummy key may itself
      // use the dummy key, and is the one packet that may once crypto init has
      // completed (see #dummyCommandIDs). A dummy-keyed command after that is
      // dropped: the dummy key is public.
      if (!dummy && pType === PacketType.Ack && !unencrypted) {
        try {
          const plaintext = this.#crypt.decrypt(
            pType,
            p.id,
            gen,
            header,
            ciphertext,
            tag,
            true,
            false,
          );
          const acked = plaintext.length >= 2 ? (plaintext[0]! << 8) | plaintext[1]! : Number.NaN;
          if (this.#dummyCommandIDs.delete(acked)) return { plaintext, dummyUsed: true };
        } catch {
          // fall through
        }
      }

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
    const queue = pType === PacketType.Command ? this.#commandQueue : this.#commandLowQueue;
    const held = queue.get(p.id)?.data.length ?? 0;
    // The packet the queue waits for is always taken: it is what drains it.
    const next = pType === PacketType.Command ? this.#nextCommandID : this.#nextCommandLowID;
    if (p.id !== next && this.#queuedBytes - held + p.data.length > MAX_QUEUED_BYTES) {
      // Not acknowledged: the server sends it again.
      this.#logger.debug("dropped a command packet: the receive queues are full", { id: p.id });
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

    this.#hold(queue, p);

    if (isCommand) {
      this.#fastForwardMissingPackets(queue, win, true);
    } else {
      this.#fastForwardMissingPackets(queue, win, false);
    }

    while (true) {
      const current = isCommand ? this.#nextCommandID : this.#nextCommandLowID;
      const packet = queue.get(current);
      if (packet === undefined) break;

      const result = this.#tryReassemble(packet, queue, current, win);
      if (!result) break;

      const [reassembled, newNext] = result;
      if (isCommand) this.#nextCommandID = newNext;
      else this.#nextCommandLowID = newNext;

      if (reassembled === null) {
        this.#logger.debug("dropped a command over the reassembly limit", { id: current });
        continue;
      }
      if (!this.#tryDecompress(reassembled)) continue;
      this.onPacket?.(reassembled);
    }
  }

  /** Put a packet in its queue, counting its bytes; one with the same id is replaced. */
  #hold(queue: Map<number, Packet>, p: Packet): void {
    this.#release(queue, p.id);
    queue.set(p.id, p);
    this.#queuedBytes += p.data.length;
  }

  #release(queue: Map<number, Packet>, id: number): void {
    const held = queue.get(id);
    if (held === undefined) return;
    queue.delete(id);
    this.#queuedBytes -= held.data.length;
  }

  #nextCommandID = 0;
  #nextCommandLowID = 0;

  #fastForwardMissingPackets(
    queue: Map<number, Packet>,
    win: GenerationWindow,
    isCommand: boolean,
  ): void {
    let nextID = isCommand ? this.#nextCommandID : this.#nextCommandLowID;
    while (!queue.has(nextID) && hasOldNewerPacket(queue, nextID)) {
      nextID = (nextID + 1) & 0xffff;
      win.advance(1);
    }
    if (isCommand) this.#nextCommandID = nextID;
    else this.#nextCommandLowID = nextID;
  }

  #tryReassemble(
    startPacket: Packet,
    queue: Map<number, Packet>,
    nextID: number,
    win: GenerationWindow,
  ): [reassembled: Packet | null, newNextID: number] | null {
    if ((packetFlags(startPacket) & PacketFlags.Fragmented) === 0) {
      this.#release(queue, nextID);
      win.advance(1);
      return [startPacket, (nextID + 1) & 0xffff];
    }

    const fragments: Packet[] = [];
    let totalSize = 0;
    let currID = nextID;
    let startSeen = false;

    // Ends at the fragment that closes the command, or returns while one is
    // still missing.
    while (true) {
      const frag = queue.get(currID);
      if (!frag) return null;
      fragments.push(frag);
      totalSize += frag.data.length;
      if (totalSize > MAX_REASSEMBLED_SIZE) {
        // Dropped whole, so the window moves past it rather than waiting on
        // the rest of a command that will never be accepted.
        for (let i = 0; i < fragments.length; i++) {
          this.#release(queue, nextID);
          win.advance(1);
          nextID = (nextID + 1) & 0xffff;
        }
        return [null, nextID];
      }

      const fragmented = (packetFlags(frag) & PacketFlags.Fragmented) !== 0;
      if (!startSeen) {
        startSeen = true;
        if (!fragmented) break;
      } else if (fragmented) {
        break;
      }
      currID = (currID + 1) & 0xffff;
    }

    const combined = new Uint8Array(totalSize);
    let pos = 0;
    for (const frag of fragments) {
      combined.set(frag.data, pos);
      pos += frag.data.length;
      this.#release(queue, nextID);
      win.advance(1);
      nextID = (nextID + 1) & 0xffff;
    }

    startPacket.data = combined;
    startPacket.typeFlagged &= ~PacketFlags.Fragmented;
    return [startPacket, nextID];
  }

  /** Decompress a command in place; false when it cannot be, and is to be dropped. */
  #tryDecompress(packet: Packet): boolean {
    if ((packetFlags(packet) & PacketFlags.Compressed) === 0) return true;
    try {
      const qlz = new Qlz();
      packet.data = qlz.decompress(packet.data);
      packet.typeFlagged &= ~PacketFlags.Compressed;
      return true;
    } catch (err) {
      // Passing the compressed bytes on as if they were the command would
      // hand the parser garbage.
      this.#logger.debug("dropped a command that failed to decompress", {
        id: packet.id,
        error: String(err),
      });
      return false;
    }
  }

  #updatePostReceiveState(p: Packet): void {
    const pType = packetType(p);

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
    const now = performance.now();

    if (now - this.#lastMessageReceived > PACKET_TIMEOUT_MS) {
      this.#logger.warn("idle timeout");
      this.#triggerClose(new ConnectionTimeoutError());
      return;
    }

    if (this.#initPacketCheck) {
      this.#doResend(this.#initPacketCheck, now);
    }

    for (const [key, rp] of this.#ackManager) {
      if (now - rp.firstSend > PACKET_TIMEOUT_MS) {
        this.#ackManager.delete(key);
        this.#triggerClose(new ConnectionTimeoutError());
        return;
      }
      this.#doResend(rp, now);
    }
  }

  #doResend(rp: ResendPacket, now: number): void {
    if (now - rp.lastSend < rp.nextInterval) return;

    rp.lastSend = now;
    rp.retryCount++;
    this.#resends++;
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

/** Close a socket that may already be closed; dgram throws on a second close. */
function closeQuietly(socket: DatagramSocket): void {
  try {
    socket.close();
  } catch {
    // Already closed.
  }
}

function applyProtocolFlags(pType: PacketType, flags: number): number {
  if (pType === PacketType.Command || pType === PacketType.CommandLow) {
    return flags | PacketFlags.NewProtocol;
  }
  return flags;
}

function hasOldNewerPacket(queue: Map<number, Packet>, nextID: number): boolean {
  const now = performance.now();
  for (const [id, pkg] of queue) {
    const diff = (id - nextID + 0x10000) & 0xffff;
    if (diff < 0x8000 && now - pkg.receivedAt > 5_000) {
      return true;
    }
  }
  return false;
}
