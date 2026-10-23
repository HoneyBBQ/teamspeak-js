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
  serverCapabilities: { family: ServerFamily; version: string; extensions: readonly string[] } = {
    family: "ts6",
    version: "6.0.0-beta13.1",
    extensions: ["FILETIME", "STREAM_P2P"],
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
  /** The options each command was sent with, parallel to `sent`. */
  readonly sentOptions: Array<CommandOptions | undefined> = [];
  /**
   * The `setupstream` commands waiting for their announcement, oldest first.
   * Unless `answer` takes the command, it is not answered until `announce`
   * does, as the real client answers it with the announcement carrying its
   * `return_code`.
   */
  readonly setups: Array<{
    readonly request: CommandRequest;
    readonly returnCode: string;
    readonly resolve: (rows: Array<Record<string, string>>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  /** While set, a command waits for its turn on the flood throttle: it is not sent, and gives up when its signal aborts. */
  holdSends = false;
  #listeners = new Map<string, Handler[]>();
  #returnCode = 0;

  send(request: CommandRequest, options?: CommandOptions): Promise<Array<Record<string, string>>> {
    this.sent.push(request);
    this.sentOptions.push(options);
    if (this.holdSends) {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        });
      });
    }
    options?.onSent?.();
    const answered = this.answer(request);
    if (answered !== undefined || request.command !== "setupstream") {
      return answered ?? Promise.resolve([]);
    }
    return new Promise((resolve, reject) => {
      this.setups.push({ request, returnCode: String(++this.#returnCode), resolve, reject });
    });
  }

  /**
   * The server announces the stream the `which`th waiting `setupstream`
   * started: the notification, with the command's `return_code`, ahead of the
   * answer to the command, as measured. Pass `{ answer: false }` for the
   * notification alone, and settle the command with `failSetup` or later.
   */
  announce(params: Record<string, string>, which = 0): void {
    const [setup] = this.setups.splice(which, 1);
    if (setup === undefined) throw new Error("no setupstream is waiting");
    const row = { ...params, return_code: setup.returnCode };
    this.notify("notifystreamstarted", row);
    setup.resolve([row]);
  }

  /** The server's `error` for the `which`th waiting `setupstream`. */
  failSetup(error: unknown, which = 0): void {
    const [setup] = this.setups.splice(which, 1);
    if (setup === undefined) throw new Error("no setupstream is waiting");
    setup.reject(error);
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
