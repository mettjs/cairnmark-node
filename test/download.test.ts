import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CairnMark, CairnMarkError, ChecksumMismatchError, NotFoundError } from "../src/index.js";
import { fileJson, readAll, sendJson, serve, type Handler } from "./helpers.js";

const CONTENT = Buffer.from("hello world");
const CHECKSUM = createHash("sha256").update(CONTENT).digest("hex");

/** Mimic the server's contract: metadata, 302 presign, 206 for ranges. */
function downloadHandler(content = CONTENT, checksum = CHECKSUM): Handler {
  return (req, res) => {
    if (req.url === "/files/abc/metadata") {
      return sendJson(
        res,
        200,
        fileJson({ checksum_sha256: checksum, size_bytes: content.length }),
      );
    }
    if (req.url === "/presigned/abc") {
      res.writeHead(200);
      return res.end(content);
    }
    if (req.url === "/files/abc") {
      const range = req.headers.range;
      if (range) {
        const [start, end] = range.replace("bytes=", "").split("-").map(Number);
        res.writeHead(206);
        return res.end(content.subarray(start, (end ?? content.length - 1) + 1));
      }
      res.writeHead(302, { location: "/presigned/abc" });
      return res.end();
    }
    res.writeHead(500);
    res.end();
  };
}

describe("download", () => {
  it("follows the presign redirect and verifies the checksum", async () => {
    const cm = new CairnMark(await serve(downloadHandler()));

    const dl = await cm.download("abc", { verify: true });
    expect((await readAll(dl.stream)).equals(CONTENT)).toBe(true);
    expect(dl.file.id).toBe("abc");
    expect(dl.file.checksumSha256).toBe(CHECKSUM);
  });

  it("errors the stream on corruption", async () => {
    const cm = new CairnMark(await serve(downloadHandler(CONTENT, "deadbeef")));

    const dl = await cm.download("abc", { verify: true });
    await expect(readAll(dl.stream)).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it("requests a byte range through the server", async () => {
    const cm = new CairnMark(await serve(downloadHandler()));

    const dl = await cm.download("abc", { offset: 6, length: 5 });
    expect((await readAll(dl.stream)).toString()).toBe("world");
  });

  it("rejects verify combined with a range", async () => {
    const cm = new CairnMark(await serve(downloadHandler()));
    await expect(cm.download("abc", { verify: true, offset: 1 })).rejects.toBeInstanceOf(
      CairnMarkError,
    );
  });

  it("downloadToFile writes verified content", async () => {
    const cm = new CairnMark(await serve(downloadHandler()));
    const dest = join(mkdtempSync(join(tmpdir(), "cairnmark-")), "out.bin");

    const f = await cm.downloadToFile("abc", dest);
    expect(f.id).toBe("abc");
    expect(readFileSync(dest).equals(CONTENT)).toBe(true);
  });

  it("downloadToFile removes a corrupt result", async () => {
    const cm = new CairnMark(await serve(downloadHandler(CONTENT, "deadbeef")));
    const dest = join(mkdtempSync(join(tmpdir(), "cairnmark-")), "out.bin");

    await expect(cm.downloadToFile("abc", dest)).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(dest)).toBe(false);
  });

  it("presignUrl returns the Location without following it", async () => {
    let presignedHits = 0;
    const url = await serve((req, res) => {
      if (req.url === "/presigned/abc") {
        presignedHits++;
        res.writeHead(200);
        return res.end("x");
      }
      res.writeHead(302, { location: "http://store.example/bucket/abc?X-Amz-Signature=sig" });
      res.end();
    });
    const cm = new CairnMark(url);

    expect(await cm.presignUrl("abc")).toBe("http://store.example/bucket/abc?X-Amz-Signature=sig");
    expect(presignedHits).toBe(0);
  });

  it("maps a missing file to NotFoundError", async () => {
    const url = await serve((req, res) => sendJson(res, 404, { error: "file not found" }));
    const cm = new CairnMark(url, { retries: 0 });
    await expect(cm.download("nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});
