import type { StreamsClient } from "@honeybbq/teamspeak/stream";
import type { Client } from "./client.js";

// A voice Client is what `Streams` attaches to: this stops compiling when the
// client and the interface it is read through drift apart.
export const attachable: (client: Client) => StreamsClient = (client) => client;
