/**
 * Full round-trip against a live server (the service repo's compose stack):
 *
 *     docker compose up -d --build   # in the CairnMark repo
 *     npm run test:integration
 *
 * Honors CAIRNMARK_BASE_URL (default http://localhost:8080).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CairnMark, NotFoundError } from "../src/index.js";
import { readAll } from "./helpers.js";

const BASE_URL = process.env.CAIRNMARK_BASE_URL ?? "http://localhost:8080";
const CONTENT = Buffer.from("integration round-trip payload");

describe.runIf(process.env.CAIRNMARK_INTEGRATION === "1")("integration round-trip", () => {
  it("uploads, searches, downloads, patches, and deletes", async () => {
    const cm = new CairnMark(BASE_URL, { timeoutMs: 30_000 });
    await cm.ready();

    // Upload with tags and an auto-generated idempotency key.
    const tag = `it-node-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const f = await cm.upload(new Uint8Array(CONTENT), {
      filename: "roundtrip.txt",
      contentType: "text/plain",
      metadata: { suite: tag },
      idempotencyKey: "auto",
    });
    expect(f.checksumSha256).toBeTruthy();

    // Tag search finds exactly this file.
    const found = [];
    for await (const g of cm.listAll({ tags: { suite: tag } })) found.push(g.id);
    expect(found).toEqual([f.id]);

    // Presign URL minted without being followed.
    expect(await cm.presignUrl(f.id)).toBeTruthy();

    // Verified full download via the presign redirect.
    const dl = await cm.download(f.id, { verify: true });
    expect((await readAll(dl.stream)).equals(CONTENT)).toBe(true);

    // Verified download to disk.
    const dest = join(mkdtempSync(join(tmpdir(), "cairnmark-")), "out.bin");
    await cm.downloadToFile(f.id, dest);
    expect(readFileSync(dest).equals(CONTENT)).toBe(true);

    // Range download of bytes 12..21 ("round-trip").
    const rdl = await cm.download(f.id, { offset: 12, length: 10 });
    expect((await readAll(rdl.stream)).toString()).toBe(CONTENT.subarray(12, 22).toString());

    // Metadata patch flips updatedAt from null and keeps merged tags.
    const patched = await cm.updateMetadata(f.id, { reviewed: true });
    expect(patched.updatedAt).not.toBeNull();
    expect(patched.metadata.suite).toBe(tag);

    // Delete, then confirm the id is gone.
    await cm.delete(f.id);
    await expect(cm.getMetadata(f.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
