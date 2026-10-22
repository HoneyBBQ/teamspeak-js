import { Agent, request } from "node:https";

/**
 * A `fetch` that trusts one CA, over `node:https`. This is the example the
 * `fetch` option's documentation gives for a private CA.
 */
export function fetchTrusting(trusted: Buffer): typeof fetch {
  const agent = new Agent({ ca: trusted });
  return ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        { method: init.method, headers: init.headers as Record<string, string>, agent },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })),
          );
        },
      );
      req.on("error", reject);
      req.end(init.body as string);
    })) as unknown as typeof fetch;
}
