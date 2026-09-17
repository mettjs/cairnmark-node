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

import { CairnMark, NotFoundError, TAG_ARCHIVE_ID, TAG_ARCHIVE_PATH } from "../src/index.js";
import { readAll, zipStored } from "./helpers.js";

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

  it("lists and extracts an archive, then serves the extracted entry", async () => {
    const cm = new CairnMark(BASE_URL, { timeoutMs: 30_000 });
    const doc = Buffer.from("%PDF-1.7 integration quarterly report");
    const zip = zipStored({
      "reports/q3.pdf": doc,
      "reports/data.json": '{"ok":true}',
      "__MACOSX/reports/._q3.pdf": "junk",
    });

    const arch = await cm.upload(new Uint8Array(zip), {
      filename: "docs.zip",
      contentType: "application/zip",
      idempotencyKey: "auto",
    });
    try {
      // List: the junk is flagged, the document is selectable with its type.
      const entries = await cm.archiveEntries(arch.id);
      const q3 = entries.find((e) => e.name === "reports/q3.pdf");
      expect(q3).toMatchObject({
        selectable: true,
        contentType: "application/pdf",
        size: doc.length,
      });
      expect(entries.find((e) => e.name.startsWith("__MACOSX/"))).toMatchObject({
        selectable: false,
        reason: "platform_metadata",
      });

      // Extract just that entry.
      const sum = await cm.extract(arch.id, { entries: [q3!.index] });
      expect(sum.extracted).toBe(1);
      expect(sum.skippedByReason.not_selected).toBe(1);
      expect(sum.skippedByReason.platform_metadata).toBe(1);

      // Find it by its tags and download it verified.
      const children = [];
      for await (const c of cm.listAll({
        tags: { [TAG_ARCHIVE_ID]: arch.id, [TAG_ARCHIVE_PATH]: "reports/q3.pdf" },
      })) {
        children.push(c);
      }
      expect(children).toHaveLength(1);
      const child = children[0]!;
      try {
        expect(child.filename).toBe("q3.pdf");
        const dl = await cm.download(child.id, { verify: true });
        expect((await readAll(dl.stream)).equals(doc)).toBe(true);

        // The scoped listing sees it; a re-run is a no-op.
        const only = await cm.list({ tags: { [TAG_ARCHIVE_ID]: arch.id }, entries: "only" });
        expect(only.count).toBe(1);
        const again = await cm.extract(arch.id, { entries: [q3!.index] });
        expect(again.extracted).toBe(0);
        expect(again.skippedByReason.already_extracted).toBe(1);

        // The job surface underneath: submit without waiting, read it, wait
        // for it, and cancel a finished job as a no-op.
        const job = await cm.extractAsync(arch.id);
        expect(job.archiveId).toBe(arch.id);
        expect((await cm.job(job.id)).id).toBe(job.id);
        const done = await cm.waitForJob(job.id);
        expect(done.status).toBe("succeeded");
        expect(done.summary?.extracted).toBe(1); // data.json, the entry not selected before
        expect((await cm.cancelJob(job.id)).status).toBe("succeeded");
        // Cancel straight after submitting: usually still pending and
        // cancelled outright, but a fast pickup may finish it first — both
        // are correct terminal states.
        const late = await cm.extractAsync(arch.id);
        await cm.cancelJob(late.id);
        expect(["cancelled", "succeeded"]).toContain((await cm.waitForJob(late.id)).status);
        for await (const extra of cm.listAll({ tags: { [TAG_ARCHIVE_ID]: arch.id } })) {
          if (extra.id !== child.id) await cm.delete(extra.id);
        }
      } finally {
        await cm.delete(child.id);
      }
    } finally {
      await cm.delete(arch.id);
    }
  });
});
