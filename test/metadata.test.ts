import { describe, expect, it } from "vitest";

import { CairnMark, CairnMarkError, NotFoundError } from "../src/index.js";
import { fileJson, sendJson, serve } from "./helpers.js";

describe("metadata", () => {
  it("getMetadata parses the record to camelCase", async () => {
    const url = await serve((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/files/abc/metadata");
      sendJson(res, 200, fileJson());
    });
    const cm = new CairnMark(url);

    const f = await cm.getMetadata("abc");
    expect(f).toEqual({
      id: "abc",
      filename: "a.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      checksumSha256: "cafe",
      metadata: { env: "demo" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: null, // untouched original
    });
  });

  it.each([
    ["merge", "/files/abc/metadata"],
    ["replace", "/files/abc/metadata?mode=replace"],
  ] as const)("updateMetadata %s sends the right request", async (mode, wantUrl) => {
    let seen: { url?: string; body?: string; contentType?: string } = {};
    const url = await serve((req, res, body) => {
      seen = {
        url: req.url,
        body: body.toString(),
        contentType: String(req.headers["content-type"]),
      };
      sendJson(res, 200, fileJson({ updated_at: "2026-02-01T00:00:00Z" }));
    });
    const cm = new CairnMark(url);

    const f = await cm.updateMetadata("abc", { reviewed: true }, { mode });
    expect(f.updatedAt).toBe("2026-02-01T00:00:00Z");
    expect(seen.url).toBe(wantUrl);
    expect(seen.body).toBe('{"reviewed":true}');
    expect(seen.contentType).toBe("application/json");
  });

  it("updateMetadata rejects a bad mode", async () => {
    const cm = new CairnMark("http://localhost:1");
    await expect(cm.updateMetadata("abc", {}, { mode: "overwrite" as any })).rejects.toBeInstanceOf(
      CairnMarkError,
    );
  });

  it("delete resolves on 204", async () => {
    let seen = "";
    const url = await serve((req, res) => {
      seen = `${req.method} ${req.url}`;
      res.writeHead(204);
      res.end();
    });
    const cm = new CairnMark(url);

    await cm.delete("abc");
    expect(seen).toBe("DELETE /files/abc");
  });

  it("delete maps 404 to NotFoundError", async () => {
    const url = await serve((req, res) => sendJson(res, 404, { error: "file not found" }));
    const cm = new CairnMark(url, { retries: 0 });
    await expect(cm.delete("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("path-escapes the file id", async () => {
    let seenUrl = "";
    const url = await serve((req, res) => {
      seenUrl = String(req.url);
      sendJson(res, 200, fileJson());
    });
    const cm = new CairnMark(url);
    await cm.getMetadata("a/b");
    expect(seenUrl).toBe("/files/a%2Fb/metadata");
  });
});
