import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

/** A real HTTP server for the test's lifetime; body is pre-collected. */
export async function serve(handler: Handler): Promise<string> {
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => void srv.close(() => resolve())));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

export function fileJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "abc",
    filename: "a.txt",
    content_type: "text/plain",
    size_bytes: 5,
    checksum_sha256: "cafe",
    metadata: { env: "demo" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
    ...overrides,
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
