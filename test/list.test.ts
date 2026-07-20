import { describe, expect, it } from "vitest";

import { CairnMark, InvalidRequestError } from "../src/index.js";
import { fileJson, sendJson, serve, type Handler } from "./helpers.js";

describe("list", () => {
  it("sends the filter params", async () => {
    let seenUrl = "";
    const url = await serve((req, res) => {
      seenUrl = String(req.url);
      sendJson(res, 200, { files: [], limit: 10, count: 0 });
    });
    const cm = new CairnMark(url);

    const page = await cm.list({
      contentType: "text/plain",
      tags: { env: "demo" },
      limit: 10,
      cursor: "cur1",
    });
    expect(page.files).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    const params = new URL(seenUrl, "http://x").searchParams;
    expect(params.get("content_type")).toBe("text/plain");
    expect(params.get("tag.env")).toBe("demo");
    expect(params.get("limit")).toBe("10");
    expect(params.get("cursor")).toBe("cur1");
  });
});

/** Serve n files two per page, exercising the exact-multiple case: the last
 * full page still carries a cursor to one final empty page. */
function pagedHandler(n: number): Handler {
  return (req, res) => {
    const cursor = new URL(String(req.url), "http://x").searchParams.get("cursor");
    const start = cursor ? Number(cursor.replace("f", "")) : 0;
    const files = [];
    for (let i = start; i < Math.min(start + 2, n); i++) files.push(fileJson({ id: `f${i + 1}` }));
    const body: Record<string, unknown> = { files, limit: 2, count: files.length };
    if (files.length === 2) body.next_cursor = `f${start + 2}`;
    sendJson(res, 200, body);
  };
}

describe("listAll", () => {
  it("paginates through every page including the trailing empty one", async () => {
    const cm = new CairnMark(await serve(pagedHandler(4)));

    const ids = [];
    for await (const f of cm.listAll({ limit: 2 })) ids.push(f.id);
    expect(ids).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("is lazy — breaking early stops fetching", async () => {
    let requests = 0;
    const inner = pagedHandler(100);
    const url = await serve((req, res, body) => {
      requests++;
      inner(req, res, body);
    });
    const cm = new CairnMark(url);

    let seen = 0;
    for await (const _ of cm.listAll({ limit: 2 })) {
      void _;
      if (++seen === 3) break;
    }
    expect(requests).toBe(2); // breaking mid-page 2 must not fetch page 3
  });

  it("rejects on a fetch error", async () => {
    const url = await serve((req, res) => sendJson(res, 400, { error: "bad cursor" }));
    const cm = new CairnMark(url, { retries: 0 });

    const iterate = async () => {
      for await (const _ of cm.listAll()) void _;
    };
    await expect(iterate()).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
