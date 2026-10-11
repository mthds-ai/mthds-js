/**
 * A loopback HTTP server standing in for PostHog's capture endpoint or for the mthds.sh registry
 * route, so no test ever reaches either. It records every request and answers with what the test
 * gives it.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface Reply {
  status: number;
  body?: unknown;
}

export type Responder = (request: RecordedRequest) => Reply;

export interface LoopbackServer {
  /** The server's origin, `http://127.0.0.1:<port>`. */
  origin: string;
  requests: RecordedRequest[];
  /** Change what the server answers from now on. */
  respond(responder: Responder): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    request.on("error", reject);
  });
}

export async function startLoopbackServer(
  responder: Responder = () => ({ status: 200, body: { status: "Ok" } }),
): Promise<LoopbackServer> {
  let current = responder;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void readBody(request).then((text) => {
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Recorded as text.
      }
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        path: request.url ?? "",
        body,
      };
      requests.push(recorded);
      const reply = current(recorded);
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    respond(next: Responder) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
