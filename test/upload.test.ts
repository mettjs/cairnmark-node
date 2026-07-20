import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CairnMark, ServerError, TooLargeError } from "../src/index.js";
import { fileJson, sendJson, serve } from "./helpers.js";

describe("upload", () => {
  it("sends body, filename param, and headers", async () => {
    let seen: { url?: string; headers?: Record<string, unknown>; body?: string } = {};
    const url = await serve((req, res, body) => {
      seen = { url: req.url, headers: { ...req.headers }, body: body.toString() };
      sendJson(res, 201, fileJson());
    });
    const cm = new CairnMark(url);

    const f = await cm.upload("hello", {
      filename: "a.txt",
      contentType: "text/plain",
      metadata: { env: "demo", n: 3 },
      idempotencyKey: "k1",
    });
    expect(f.id).toBe("abc");
    expect(seen.url).toBe("/files?filename=a.txt");
    expect(seen.body).toBe("hello");
    expect(seen.headers?.["content-type"]).toBe("text/plain");
    expect(seen.headers?.["idempotency-key"]).toBe("k1");
    expect(JSON.parse(String(seen.headers?.["x-metadata"]))).toEqual({ env: "demo", n: 3 });
  });

  it("retries with an idempotency key, resending the full body", async () => {
    const bodies: string[] = [];
    const url = await serve((req, res, body) => {
      bodies.push(body.toString());
      if (bodies.length === 1) return sendJson(res, 500, { error: "transient" });
      sendJson(res, 201, fileJson());
    });
    const cm = new CairnMark(url);

    await cm.upload("hello", { idempotencyKey: "k1" });
    expect(bodies).toEqual(["hello", "hello"]);
  });

  it("does not retry without an idempotency key", async () => {
    let attempts = 0;
    const url = await serve((req, res) => {
      attempts++;
      sendJson(res, 500, { error: "transient" });
    });
    const cm = new CairnMark(url);

    await expect(cm.upload("hello")).rejects.toBeInstanceOf(ServerError);
    expect(attempts).toBe(1);
  });

  it("does not retry a one-shot stream even with a key", async () => {
    let attempts = 0;
    const url = await serve((req, res) => {
      attempts++;
      sendJson(res, 500, { error: "transient" });
    });
    const cm = new CairnMark(url);

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    });
    await expect(cm.upload(stream, { idempotencyKey: "k1" })).rejects.toBeInstanceOf(ServerError);
    expect(attempts).toBe(1);
  });

  it("retries a factory body, invoking it fresh per attempt", async () => {
    const bodies: string[] = [];
    const url = await serve((req, res, body) => {
      bodies.push(body.toString());
      if (bodies.length === 1) return sendJson(res, 500, { error: "transient" });
      sendJson(res, 201, fileJson());
    });
    const cm = new CairnMark(url);

    const factory = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("hello"));
          c.close();
        },
      });
    await cm.upload(factory, { idempotencyKey: "k1" });
    expect(bodies).toEqual(["hello", "hello"]);
  });

  it('generates distinct keys with idempotencyKey: "auto"', async () => {
    const keys = new Set<string>();
    const url = await serve((req, res) => {
      keys.add(String(req.headers["idempotency-key"]));
      sendJson(res, 201, fileJson());
    });
    const cm = new CairnMark(url);

    await cm.upload("x", { idempotencyKey: "auto" });
    await cm.upload("x", { idempotencyKey: "auto" });
    expect(keys.size).toBe(2);
    for (const k of keys) expect(k.length).toBeGreaterThan(0);
  });

  it("maps 413 to TooLargeError", async () => {
    const url = await serve((req, res) =>
      sendJson(res, 413, { error: "upload exceeds the 10-byte limit" }),
    );
    const cm = new CairnMark(url, { retries: 0 });
    await expect(cm.upload("hello")).rejects.toBeInstanceOf(TooLargeError);
  });

  it("uploadFile infers name and size and streams the content", async () => {
    let seen: { url?: string; contentLength?: string; body?: string } = {};
    const url = await serve((req, res, body) => {
      seen = {
        url: req.url,
        contentLength: String(req.headers["content-length"]),
        body: body.toString(),
      };
      sendJson(res, 201, fileJson());
    });
    const dir = mkdtempSync(join(tmpdir(), "cairnmark-"));
    const src = join(dir, "hello.txt");
    writeFileSync(src, "hello from disk");
    const cm = new CairnMark(url);

    await cm.uploadFile(src, { metadata: { env: "demo" } });
    expect(seen.url).toBe("/files?filename=hello.txt");
    expect(seen.contentLength).toBe(String("hello from disk".length));
    expect(seen.body).toBe("hello from disk");
  });
});
