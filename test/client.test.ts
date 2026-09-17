import { describe, expect, it } from "vitest";

import {
  APIError,
  CairnMark,
  IdempotencyConflictError,
  IdempotencyGoneError,
  InvalidRequestError,
  NotArchiveError,
  NotFoundError,
  RangeNotSatisfiableError,
  ServerError,
  TooLargeError,
  VERSION,
} from "../src/index.js";
import { fileJson, sendJson, serve } from "./helpers.js";

describe("constructor", () => {
  it("rejects malformed base URLs", () => {
    expect(() => new CairnMark("not a url")).toThrow();
  });
});

describe("error mapping", () => {
  const cases: [number, unknown][] = [
    [400, InvalidRequestError],
    [404, NotFoundError],
    [409, IdempotencyConflictError],
    [410, IdempotencyGoneError],
    [413, TooLargeError],
    [415, NotArchiveError],
    [416, RangeNotSatisfiableError],
    [500, ServerError],
  ];

  it.each(cases)("maps %d to the typed error", async (status, errClass) => {
    const url = await serve((req, res) => {
      res.setHeader("retry-after", "7");
      sendJson(res, status, { error: "boom" });
    });
    const cm = new CairnMark(url, { retries: 0 });

    const err = await cm.getMetadata("abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(errClass as any);
    expect(err).toBeInstanceOf(APIError);
    const apiErr = err as APIError;
    expect(apiErr.status).toBe(status);
    expect(apiErr.serverMessage).toBe("boom");
    if (status === 409) expect(apiErr.retryAfterMs).toBe(7000);
  });

  it("falls back to the body text for non-JSON errors", async () => {
    const url = await serve((req, res) => {
      res.writeHead(404);
      res.end("plain not found");
    });
    const cm = new CairnMark(url, { retries: 0 });
    await expect(cm.getMetadata("abc")).rejects.toMatchObject({
      serverMessage: "plain not found",
    });
  });
});

describe("retries and headers", () => {
  it("retries small calls on 5xx", async () => {
    let attempts = 0;
    const url = await serve((req, res) => {
      attempts++;
      if (attempts === 1) return sendJson(res, 500, { error: "transient" });
      sendJson(res, 200, fileJson());
    });
    const cm = new CairnMark(url);

    const f = await cm.getMetadata("abc");
    expect(f.id).toBe("abc");
    expect(attempts).toBe(2);
  });

  it("sends default headers and User-Agent", async () => {
    let ua = "";
    let auth = "";
    const url = await serve((req, res) => {
      ua = String(req.headers["user-agent"]);
      auth = String(req.headers["authorization"]);
      res.writeHead(200);
      res.end("ok");
    });
    const cm = new CairnMark(url, { headers: { Authorization: "Bearer tok" } });

    await cm.health();
    expect(ua).toBe(`cairnmark-node/${VERSION}`);
    expect(auth).toBe("Bearer tok");
  });
});
