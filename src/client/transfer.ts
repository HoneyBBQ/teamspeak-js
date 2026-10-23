/**
 * File transfer data.
 *
 * Negotiating a transfer is a command (`initFileUpload`, `initFileDownload`);
 * the bytes then go over a separate TCP connection to the server's file
 * transfer port, opened with the key the negotiation returned.
 */

import { connect } from "node:net";
import { pipeline } from "node:stream/promises";
import { Transform, Writable, type Duplex, type Readable } from "node:stream";
import type { FileUploadInfo, FileDownloadInfo } from "@honeybbq/teamspeak";
import type { FileTransferSocketFactory } from "./types.js";
import { FileTransferError } from "./errors.js";
import { callHook } from "./hooks.js";
import { joinHostPort } from "./address.js";
import { abortable } from "./abort.js";

/** How long dialing may take before it fails, unless a signal says otherwise. */
const DIAL_TIMEOUT_MS = 10_000;

/** How long a transfer may go without moving a byte, unless `idleTimeoutMs` says otherwise. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** How many bytes move between two calls of the `progress` hook, at least. */
const PROGRESS_STEP_BYTES = 64 * 1024;

/** The file transfer ports a connection can be made to. */
const MAX_PORT = 65535;

/** Where a failed transfer failed. */
export type FileTransferStage = "dial" | "transfer";

/** The file transfer port is about to be dialled. */
export interface FileTransferDialStartInfo {
  /** The `host:port` being dialled. */
  readonly addr: string;
}

/** The connection is open and the transfer key has been sent. */
export interface FileTransferDialDoneInfo {
  /** The `host:port` dialled. */
  readonly addr: string;
  /** The local socket's `host:port`; empty when the socket does not say. */
  readonly localAddr: string;
  /** Milliseconds since `dialStart`. */
  readonly durationMs: number;
}

/** Data has moved. */
export interface FileTransferProgressInfo {
  /** The bytes moved so far. */
  readonly bytes: number;
  /** The bytes the transfer will move, as the negotiation fixed them. */
  readonly total: number;
}

/** The transfer succeeded. */
export interface FileTransferDoneInfo {
  /** The bytes moved. */
  readonly bytes: number;
  /** Milliseconds since `dialStart`. */
  readonly durationMs: number;
}

/** The transfer failed. */
export interface FileTransferFailedInfo {
  /** Why: the error the transfer function rejects with. */
  readonly error: unknown;
  /** The bytes moved before it failed. */
  readonly bytes: number;
  /** Milliseconds since `dialStart`. */
  readonly durationMs: number;
  /** Whether the failure came while dialling or while the data moved. */
  readonly stage: FileTransferStage;
}

/**
 * Hooks that observe one file transfer. Every hook is optional, and none ever
 * sees the transfer key.
 *
 * A hook runs synchronously on the task doing the transfer, and its return
 * value is ignored: a returned promise is not awaited. A hook that throws, or
 * whose promise rejects, is reported the way a throwing event listener is, and
 * the transfer goes on. Keep hooks quick.
 *
 * A call of `uploadFileData` or `downloadFileData` ends with exactly one of
 * `done` and `failed`; `dialFileTransfer` on its own reports `dialStart`, then
 * `dialDone` or `failed` with the stage `"dial"`.
 */
export interface FileTransferTrace {
  /** Before the file transfer port is dialled. */
  readonly dialStart?: (info: FileTransferDialStartInfo) => void;
  /** When the connection is open and the transfer key is sent. */
  readonly dialDone?: (info: FileTransferDialDoneInfo) => void;
  /** While data moves, at most once per 64 KiB, and once more at the end with the final count. */
  readonly progress?: (info: FileTransferProgressInfo) => void;
  /** When the transfer function is about to resolve. */
  readonly done?: (info: FileTransferDoneInfo) => void;
  /** When the transfer function is about to reject, a failed dial included. */
  readonly failed?: (info: FileTransferFailedInfo) => void;
}

/** Options for a file transfer. */
export interface FileTransferOptions {
  /** Abandons the transfer; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Opens the connection instead of a direct TCP dial, to route the transfer
   * through a proxy or tunnel.
   */
  readonly socketFactory?: FileTransferSocketFactory | undefined;
  /**
   * Hooks called at each milestone of this transfer. The object is copied when
   * the call starts. See {@link FileTransferTrace}.
   */
  readonly trace?: FileTransferTrace | undefined;
  /**
   * The longest, in milliseconds, the transfer may go without moving a byte,
   * the write of the transfer key included. When it passes, the transfer
   * rejects with a {@link FileTransferError} whose `cause` is a `TimeoutError`
   * and the connection is destroyed. `undefined` means the default, 30 000;
   * `0` turns the limit off.
   */
  readonly idleTimeoutMs?: number | undefined;
}

/** What a transfer's hooks share: the trace, when the call began, and what has moved. */
interface TransferTrace {
  readonly trace: FileTransferTrace | undefined;
  readonly startedAt: number;
  bytes: number;
}

/**
 * Watches a transfer for going idle. `touch()` says a byte moved; when none
 * does for the whole limit, `signal` aborts with a `TimeoutError`.
 */
interface IdleGuard {
  readonly signal: AbortSignal;
  readonly limitMs: number;
  touch(): void;
  stop(): void;
}

function newIdleGuard(options: FileTransferOptions): IdleGuard {
  const limitMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(limitMs) || limitMs < 0) {
    throw new RangeError("idleTimeoutMs must be a finite number of milliseconds, 0 or more");
  }
  const controller = new AbortController();
  if (limitMs === 0) {
    return { signal: controller.signal, limitMs, touch() {}, stop() {} };
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException(`no data moved for ${limitMs} ms`, "TimeoutError")),
    limitMs,
  );
  return {
    signal: controller.signal,
    limitMs,
    touch: () => timer.refresh(),
    stop: () => clearTimeout(timer),
  };
}

/** The error a transfer fails with when `idle` expired, else `error` as it is. */
function idleOr(idle: IdleGuard, error: unknown): unknown {
  if (!idle.signal.aborted) return error;
  return new FileTransferError(`file transfer stalled: no data moved for ${idle.limitMs} ms`, {
    cause: idle.signal.reason,
  });
}

function newTransferTrace(options: FileTransferOptions): TransferTrace {
  return {
    trace: options.trace === undefined ? undefined : { ...options.trace },
    startedAt: performance.now(),
    bytes: 0,
  };
}

function reportFailed(t: TransferTrace, error: unknown, stage: FileTransferStage): void {
  callHook(t.trace?.failed, t.trace, () => ({
    error,
    bytes: t.bytes,
    durationMs: performance.now() - t.startedAt,
    stage,
  }));
}

/**
 * Open a connection to the file transfer port and send the transfer key.
 * The caller owns the returned stream and must end or destroy it.
 */
export async function dialFileTransfer(
  host: string,
  port: number,
  key: string,
  options: FileTransferOptions = {},
): Promise<Duplex> {
  const t = newTransferTrace(options);
  const idle = newIdleGuard(options);
  try {
    return await dial(host, port, key, options, t, idle);
  } catch (error) {
    const failure = idleOr(idle, error);
    reportFailed(t, failure, "dial");
    throw failure;
  } finally {
    idle.stop();
  }
}

async function dial(
  host: string,
  port: number,
  key: string,
  options: FileTransferOptions,
  t: TransferTrace,
  idle: IdleGuard,
): Promise<Duplex> {
  const { signal, socketFactory } = options;
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new FileTransferError(`the file transfer port is ${String(port)}, not 1 to ${MAX_PORT}`);
  }
  // One budget for the connection and the key write: a peer that accepts the
  // connection and never reads would otherwise hold the write forever.
  const timeout = AbortSignal.timeout(DIAL_TIMEOUT_MS);
  const dialSignal = AbortSignal.any(
    signal ? [signal, timeout, idle.signal] : [timeout, idle.signal],
  );
  const addr = joinHostPort(host, String(port));
  callHook(t.trace?.dialStart, t.trace, () => ({ addr }));
  signal?.throwIfAborted();
  const socket: Duplex = socketFactory ? socketFactory(host, port) : connect({ host, port });

  // Until the caller takes the stream over, its errors are this function's to
  // report: a stream's unhandled `error` event takes the process down.
  const swallow = (): void => {};
  socket.on("error", swallow);
  try {
    await abortable(connected(socket), dialSignal);
    idle.touch();
    await abortable(
      new Promise<void>((resolve, reject) => {
        socket.write(key, (err) =>
          err
            ? reject(
                new FileTransferError(`failed to send transfer key: ${err.message}`, {
                  cause: err,
                }),
              )
            : resolve(),
        );
      }),
      dialSignal,
    );
    idle.touch();
  } catch (error) {
    socket.destroy();
    if (timeout.aborted && error === timeout.reason) {
      throw new FileTransferError("file transfer connection timed out", { cause: error });
    }
    throw error;
  } finally {
    socket.off("error", swallow);
  }
  callHook(t.trace?.dialDone, t.trace, () => {
    let localAddr = "";
    const local = socket as { localAddress?: unknown; localPort?: unknown };
    if (typeof local.localAddress === "string" && typeof local.localPort === "number") {
      localAddr = joinHostPort(local.localAddress, String(local.localPort));
    }
    return { addr, localAddr, durationMs: performance.now() - t.startedAt };
  });
  return socket;
}

/**
 * A pass-through that counts what moves and reports it to `progress`. It never
 * fails the pipeline: a hook's error is reported, not thrown.
 */
function countingStream(t: TransferTrace, total: number, idle: IdleGuard): Transform {
  let reported = 0;
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      t.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      idle.touch();
      if (t.bytes - reported >= PROGRESS_STEP_BYTES) {
        reported = t.bytes;
        const bytes = t.bytes;
        callHook(t.trace?.progress, t.trace, () => ({ bytes, total }));
      }
      callback(null, chunk);
    },
  });
}

/**
 * Passes exactly `expected` bytes. One more byte fails the transfer, and is
 * not passed on; a stream that ends before `expected` fails it too. `what`
 * says who fixed the size, for the message.
 */
function exactSize(expected: number, what: "announced" | "declared"): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const room = expected - received;
      if (chunk.length > room) {
        this.push(chunk.subarray(0, room));
        received = expected;
        callback(
          new FileTransferError(`file transfer sent more than the ${what} ${expected} bytes`),
        );
        return;
      }
      received += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        received === expected
          ? null
          : new FileTransferError(
              `file transfer ended after ${received} of the ${what} ${expected} bytes`,
            ),
      );
    },
  });
}

/** Run a transfer's data phase, and report how the whole call ended. */
async function transfer(
  host: string,
  port: number,
  key: string,
  total: number,
  options: FileTransferOptions,
  move: (socket: Duplex, counter: Transform, pipeOptions: { signal: AbortSignal }) => Promise<void>,
): Promise<void> {
  const t = newTransferTrace(options);
  const idle = newIdleGuard(options);
  try {
    let socket: Duplex;
    try {
      socket = await dial(host, port, key, options, t, idle);
    } catch (error) {
      const failure = idleOr(idle, error);
      reportFailed(t, failure, "dial");
      throw failure;
    }
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
      await move(socket, countingStream(t, total, idle), { signal });
    } catch (error) {
      // A pipeline aborted by the caller's signal rejects as the signal says;
      // one aborted by the idle limit is the transfer's own failure.
      const failure = idleOr(idle, error);
      reportFailed(t, failure, "transfer");
      throw failure;
    } finally {
      // The server ends a transfer it has finished, and a failed one is
      // abandoned here; either way nothing is left to keep the socket for.
      socket.destroy();
    }
  } finally {
    idle.stop();
  }
  const bytes = t.bytes;
  callHook(t.trace?.progress, t.trace, () => ({ bytes, total }));
  callHook(t.trace?.done, t.trace, () => ({
    bytes,
    durationMs: performance.now() - t.startedAt,
  }));
}

/**
 * Wait for a stream to be connected. A `node:net` socket says so with
 * `connect`; a stream from elsewhere that is already writable is taken as
 * connected.
 */
function connected(socket: Duplex): Promise<void> {
  const pending = (socket as { pending?: boolean }).pending;
  if (pending === false || (pending === undefined && socket.writable)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const done = (error?: unknown): void => {
      socket.off("connect", onConnect);
      socket.off("ready", onConnect);
      socket.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onConnect = (): void => done();
    const onError = (error: Error): void =>
      done(
        new FileTransferError(`file transfer connection failed: ${error.message}`, {
          cause: error,
        }),
      );
    socket.once("connect", onConnect);
    socket.once("ready", onConnect);
    socket.once("error", onError);
  });
}

/**
 * How many bytes a negotiated transfer moves: the file's size less the
 * position it starts from.
 */
function bytesToMove(size: bigint, seekPosition: bigint): number {
  if (seekPosition < 0n || seekPosition > size) {
    throw new FileTransferError(
      `the transfer starts at ${seekPosition}, outside a file of ${size} bytes`,
    );
  }
  return Number(size - seekPosition);
}

/**
 * A sink that hands what it is given to `dest`, one write at a time, without
 * ever ending it: the stream is the caller's, and may take more transfers.
 * `dest`'s errors fail the sink, so the pipeline sees them.
 */
function intoStream(dest: Writable): Writable {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      dest.write(chunk, callback);
    },
  });
  const onError = (error: Error): void => {
    sink.destroy(error);
  };
  dest.on("error", onError);
  // A failed `dest` reports its error a tick after the write that failed, by
  // which time this sink is closed: keep listening until that has been said.
  sink.on("close", () => setImmediate(() => dest.off("error", onError)));
  return sink;
}

/**
 * The same for a socket that is not to be ended: an upload is over when the
 * server says so, not when the last byte has left.
 */
function intoSocket(socket: Duplex): Writable {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      socket.write(chunk, callback);
    },
  });
  socket.on("error", (error: Error) => {
    sink.destroy(error);
  });
  return sink;
}

/** Resolves once the server has closed the transfer connection. */
function serverClosed(socket: Duplex, signal: AbortSignal): Promise<void> {
  if (socket.readableEnded || socket.destroyed) return Promise.resolve();
  const closed = new Promise<void>((resolve, reject) => {
    const done = (error?: Error): void => {
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", done);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onEnd = (): void => done();
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", done);
  });
  // Nothing is sent back, but the end of the stream is only seen by reading.
  socket.resume();
  return abortable(closed, signal);
}

/**
 * Upload `data` over a negotiated transfer. `data` is the file from
 * `info.seekPosition` on, and must give exactly the bytes left of
 * `info.size`: a stream that gives fewer or more fails the transfer.
 *
 * Resolves once the server has closed the transfer connection, which it does
 * when it has the file. Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0:
 * the server closes about 200 ms after the last byte of a 100 000-byte file,
 * and at once after the declared size when more is sent. A connection that
 * closes before every byte is written, or that stays open for the idle limit,
 * fails the transfer.
 */
export async function uploadFileData(
  host: string,
  info: FileUploadInfo,
  data: Readable,
  options: FileTransferOptions = {},
): Promise<void> {
  const expected = bytesToMove(info.size, info.seekPosition);
  await transfer(
    host,
    info.port,
    info.fileTransferKey,
    expected,
    options,
    async (socket, counter, pipeOptions) => {
      await pipeline(
        data,
        exactSize(expected, "declared"),
        counter,
        intoSocket(socket),
        pipeOptions,
      );
      await serverClosed(socket, pipeOptions.signal);
    },
  );
}

/**
 * Download a negotiated transfer into `dest`. Resolves once the file is
 * written; `dest` is not ended, so it may take another download.
 *
 * A download from `info.seekPosition` brings the bytes from there to the end
 * of the file: measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0, a
 * `seekpos` of 40 000 on a 100 000-byte file is answered with the whole size
 * and then 60 000 bytes.
 */
export async function downloadFileData(
  host: string,
  info: FileDownloadInfo,
  dest: Writable,
  options: FileTransferOptions = {},
): Promise<void> {
  const expected = bytesToMove(info.size, info.seekPosition);
  await transfer(
    host,
    info.port,
    info.fileTransferKey,
    expected,
    options,
    (socket, counter, pipeOptions) =>
      pipeline(socket, exactSize(expected, "announced"), counter, intoStream(dest), pipeOptions),
  );
}

export { FileTransferError };
