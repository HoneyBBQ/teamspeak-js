/**
 * A stand-in for the voice client that `Streams` attaches to: it records the
 * commands sent, answers them as the test says, and delivers the events and
 * notifications the test injects. Not part of the package.
 */

import { asClientID } from "@honeybbq/teamspeak";
import type {
  ClientEntry,
  ClientID,
  CommandOptions,
  CommandRequest,
  NotificationEvent,
  ServerFamily,
  Unsubscribe,
} from "@honeybbq/teamspeak";
import type { StreamsClient } from "../types.js";

type Handler = (payload: never) => void;

/** The value of a parameter of a recorded command, as sent. */
export function param(request: CommandRequest, key: string): string | number | bigint | boolean {
  const found = request.params?.find(([k]) => k === key);
  if (found === undefined) throw new Error(`${request.command} has no ${key}`);
  return found[1] as string | number | bigint | boolean;
}

export class FakeClient implements StreamsClient {
  status: StreamsClient["status"] = "connected";
  clientID: ClientID = asClientID(1);
  serverCapabilities: { family: ServerFamily; version: string } = {
    family: "ts6",
    version: "6.0.0-beta13.1",
  };
  readonly clients: Map<ClientID, ClientEntry> = new Map();
  readonly view: StreamsClient["view"] = {
    clients: this.clients,
    client: (id) => this.clients.get(id),
  };
  /** Every command sent, in order. */
  readonly sent: CommandRequest[] = [];
  /** How a command is answered; the default succeeds with no rows. */
  answer: (request: CommandRequest) => Promise<Array<Record<string, string>>> | undefined = () =>
    undefined;
  #listeners = new Map<string, Handler[]>();

  send(request: CommandRequest, _options?: CommandOptions): Promise<Array<Record<string, string>>> {
    this.sent.push(request);
    return this.answer(request) ?? Promise.resolve([]);
  }

  on(event: string, listener: Handler): Unsubscribe {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    const off = (): void => {
      this.#listeners.set(
        event,
        (this.#listeners.get(event) ?? []).filter((l) => l !== listener),
      );
    };
    return Object.assign(off, { [Symbol.dispose]: off });
  }

  /** How many listeners an event has. */
  listenerCount(event: string): number {
    return (this.#listeners.get(event) ?? []).length;
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? [])
      (listener as (p: unknown) => void)(payload);
  }

  /** Deliver a notification, as the client's catch-all does. */
  notify(name: string, params: Record<string, string>): void {
    const event: NotificationEvent = { name, params };
    this.emit("notification", event);
  }

  /** The commands sent so far with this name. */
  commands(name: string): CommandRequest[] {
    return this.sent.filter((r) => r.command === name);
  }

  /** Put a client in view. */
  see(id: number, extra: Partial<ClientEntry> = {}): ClientEntry {
    const entry = {
      id: asClientID(id),
      uid: `uid-${id}`,
      nickname: `client${id}`,
      ...extra,
    } as unknown as ClientEntry;
    this.clients.set(asClientID(id), entry);
    return entry;
  }
}

/** Let queued promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
