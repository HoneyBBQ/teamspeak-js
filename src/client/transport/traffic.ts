import { PacketType } from "./packet.js";

/** The three classes TeamSpeak counts traffic in. */
export type TrafficClass = "speech" | "keepalive" | "control";

/** Which class a packet type is counted in: voice is speech, ping and pong are keepalive, the rest control. */
export function trafficClassOf(pType: PacketType): TrafficClass {
  if (pType === PacketType.Voice || pType === PacketType.VoiceWhisper) return "speech";
  if (pType === PacketType.Ping || pType === PacketType.Pong) return "keepalive";
  return "control";
}

/** What one direction of one class has carried. */
export interface TrafficFigures {
  /** Datagrams, resent ones included. */
  readonly packets: number;
  /** Bytes of those datagrams, headers included. */
  readonly bytes: number;
  /** Bytes in the last second. */
  readonly bytesLastSecond: number;
  /** Bytes per second averaged over the last minute. */
  readonly bytesPerSecondLastMinute: number;
}

/** The traffic of a connection, per direction and class. */
export interface TrafficSnapshot {
  readonly sent: Readonly<Record<TrafficClass, TrafficFigures>>;
  readonly received: Readonly<Record<TrafficClass, TrafficFigures>>;
}

const WINDOW_SECONDS = 60;
const classes: readonly TrafficClass[] = ["speech", "keepalive", "control"];

/** One direction of one class: totals plus a ring of one-second byte buckets. */
class Counter {
  packets = 0;
  bytes = 0;
  readonly buckets = new Float64Array(WINDOW_SECONDS);
  /** The second (whole) the newest bucket stands for. */
  second = 0;

  advance(second: number): void {
    if (second <= this.second) return;
    const gap = Math.min(second - this.second, WINDOW_SECONDS);
    for (let i = 1; i <= gap; i++) this.buckets[(this.second + i) % WINDOW_SECONDS] = 0;
    this.second = second;
  }
}

/**
 * Counts the datagrams a connection sends and receives, by class, and the
 * bytes of the last second and the last minute. Time is passed in
 * (milliseconds, monotonic) so a test can drive it.
 */
export class TrafficMeter {
  readonly #sent = new Map<TrafficClass, Counter>(classes.map((c) => [c, new Counter()]));
  readonly #received = new Map<TrafficClass, Counter>(classes.map((c) => [c, new Counter()]));

  recordSent(pType: PacketType, bytes: number, nowMs: number): void {
    this.#add(this.#sent.get(trafficClassOf(pType))!, bytes, nowMs);
  }

  recordReceived(pType: PacketType, bytes: number, nowMs: number): void {
    this.#add(this.#received.get(trafficClassOf(pType))!, bytes, nowMs);
  }

  #add(counter: Counter, bytes: number, nowMs: number): void {
    counter.advance(Math.floor(nowMs / 1000));
    counter.packets++;
    counter.bytes += bytes;
    counter.buckets[counter.second % WINDOW_SECONDS]! += bytes;
  }

  snapshot(nowMs: number): TrafficSnapshot {
    const read = (map: Map<TrafficClass, Counter>): Record<TrafficClass, TrafficFigures> => {
      const out = {} as Record<TrafficClass, TrafficFigures>;
      for (const [name, counter] of map) {
        counter.advance(Math.floor(nowMs / 1000));
        // The second in progress is incomplete, so "the last second" is the
        // one before it, and the minute is the 59 before it plus that one.
        const previous = (counter.second - 1 + WINDOW_SECONDS) % WINDOW_SECONDS;
        let minute = 0;
        for (let i = 1; i <= WINDOW_SECONDS; i++) {
          minute += counter.buckets[(counter.second - i + WINDOW_SECONDS * 2) % WINDOW_SECONDS]!;
        }
        out[name] = {
          packets: counter.packets,
          bytes: counter.bytes,
          bytesLastSecond: counter.buckets[previous]!,
          bytesPerSecondLastMinute: minute / WINDOW_SECONDS,
        };
      }
      return out;
    };
    return { sent: read(this.#sent), received: read(this.#received) };
  }
}

/** The round-trip time of the keepalive exchange: a mean and a deviation over recent samples. */
export class RoundTripEstimator {
  readonly #samples: number[] = [];

  add(ms: number): void {
    this.#samples.push(ms);
    if (this.#samples.length > 10) this.#samples.shift();
  }

  /** The mean and the standard deviation in milliseconds, or null before the first sample. */
  get(): { readonly meanMs: number; readonly deviationMs: number } | null {
    const n = this.#samples.length;
    if (n === 0) return null;
    const mean = this.#samples.reduce((a, b) => a + b, 0) / n;
    const variance = this.#samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return { meanMs: mean, deviationMs: Math.sqrt(variance) };
  }
}
