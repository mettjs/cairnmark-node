import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import {
  CairnMark,
  ExtractionCancelledError,
  ExtractionFailedError,
  IdempotencyConflictError,
  JobError,
  NotArchiveError,
  NotFoundError,
  TooLargeError,
  type JobStatus,
} from "../src/index.js";
import { sendJson, serve } from "./helpers.js";

const listing = {
  archive_id: "zip1",
  entries: [
    {
      index: 0,
      name: "reports/q3.pdf",
      size: 184322,
      content_type: "application/pdf",
      crc32: "8f2a91c4",
      selectable: true,
    },
    {
      index: 1,
      name: "__MACOSX/._q3.pdf",
      size: 220,
      crc32: "d1c0b3aa",
      selectable: false,
      reason: "platform_metadata",
    },
  ],
};

const summary = {
  archive_id: "zip1",
  entries: 2,
  extracted: 1,
  skipped: 1,
  skipped_by_reason: { platform_metadata: 1 },
  sample_skipped: [{ index: 1, name: "__MACOSX/._q3.pdf", reason: "platform_metadata" }],
};

const parsedSummary = {
  archiveId: "zip1",
  entries: 2,
  extracted: 1,
  skipped: 1,
  skippedByReason: { platform_metadata: 1 },
  sampleSkipped: [{ index: 1, name: "__MACOSX/._q3.pdf", reason: "platform_metadata" }],
};

/** A job in the server's shape. */
function jobJson(
  status: JobStatus,
  done = 0,
  total = 0,
  sum: unknown = null,
  error?: string,
  id = "j1",
): Record<string, unknown> {
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  return {
    id,
    archive_id: "zip1",
    status,
    progress: { done, total },
    cancel_requested: status === "cancelled",
    summary: sum,
    ...(error ? { error } : {}),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:05Z",
    finished_at: terminal ? "2026-01-01T00:00:10Z" : null,
  };
}

const pending = jobJson("pending");
const succeeded = jobJson("succeeded", 2, 2, summary);

/**
 * A fake of the extraction endpoints: POST submits and answers 202 with a
 * pending job, each GET of a job walks one step through `script` and the last
 * step sticks, POST cancel answers 202 cancelled. Requests are counted.
 */
async function jobServer(
  script: Record<string, unknown>[],
  opts: { conflict?: Record<string, unknown> } = {},
) {
  const seen = { submissions: 0, polls: 0, cancels: 0, body: "", type: "" };
  const url = await serve((req: IncomingMessage, res: ServerResponse, body) => {
    const path = req.url ?? "";
    if (req.method === "POST" && path.endsWith("/extract")) {
      seen.submissions++;
      seen.body = body.toString();
      seen.type = req.headers["content-type"] ?? "";
      if (opts.conflict && seen.submissions === 1) {
        res.setHeader("retry-after", "30");
        return sendJson(res, 409, opts.conflict);
      }
      res.setHeader("location", "/jobs/j1");
      return sendJson(res, 202, pending);
    }
    if (req.method === "GET" && path.startsWith("/jobs/")) {
      const step = script[Math.min(seen.polls, script.length - 1)];
      seen.polls++;
      return sendJson(res, 200, step);
    }
    if (req.method === "POST" && path.endsWith("/cancel")) {
      seen.cancels++;
      return sendJson(res, 202, jobJson("cancelled", 1, 2, summary));
    }
    sendJson(res, 404, { error: "not found" });
  });
  return { url, seen };
}

const succeeds = () => [pending, jobJson("running", 1, 2), succeeded];

const fast = (url: string, extra: ConstructorParameters<typeof CairnMark>[1] = {}) =>
  new CairnMark(url, { pollIntervalMs: 1, ...extra });

describe("archiveEntries", () => {
  it("lists the entries, camel-cased, with absent fields undefined", async () => {
    let seen = "";
    const url = await serve((req, res) => {
      seen = `${req.method} ${req.url}`;
      sendJson(res, 200, listing);
    });
    const cm = new CairnMark(url);

    const entries = await cm.archiveEntries("zip1");
    expect(seen).toBe("GET /files/zip1/archive");
    expect(entries).toEqual([
      {
        index: 0,
        name: "reports/q3.pdf",
        size: 184322,
        contentType: "application/pdf",
        crc32: "8f2a91c4",
        selectable: true,
        reason: undefined,
      },
      {
        index: 1,
        name: "__MACOSX/._q3.pdf",
        size: 220,
        contentType: undefined,
        crc32: "d1c0b3aa",
        selectable: false,
        reason: "platform_metadata",
      },
    ]);
  });

  it("maps 415 to NotArchiveError", async () => {
    const url = await serve((req, res) =>
      sendJson(res, 415, { error: "files: not a supported archive (zip)" }),
    );
    const cm = new CairnMark(url, { retries: 0 });
    await expect(cm.archiveEntries("txt")).rejects.toBeInstanceOf(NotArchiveError);
  });
});

describe("extract", () => {
  it.each([
    ["every entry", {}, "", ""],
    ["a selection", { entries: [0, 4] }, '{"entries":[0,4]}', "application/json"],
    ["an explicit empty selection", { entries: [] }, '{"entries":[]}', "application/json"],
  ])(
    "with %s submits, polls to terminal, and resolves the summary",
    async (_n, options, wantBody, wantType) => {
      const { url, seen } = await jobServer(succeeds());
      const sum = await fast(url).extract("zip1", options);
      expect(sum).toEqual(parsedSummary);
      expect(seen).toMatchObject({ submissions: 1, polls: 3, body: wantBody, type: wantType });
    },
  );

  it("extractAsync resolves the pending job at once", async () => {
    const { url, seen } = await jobServer(succeeds());
    const job = await fast(url).extractAsync("zip1", { entries: [0] });
    expect(job).toMatchObject({
      id: "j1",
      archiveId: "zip1",
      status: "pending",
      progress: { done: 0, total: 0 },
      cancelRequested: false,
      summary: undefined,
      finishedAt: null,
    });
    expect(seen.polls).toBe(0);
    expect(seen.body).toBe('{"entries":[0]}');
  });

  it("waits for the active job on a 409, then resubmits its own", async () => {
    // Another job holds the archive. Its selection may not be ours, so the
    // right move is to wait for it, then submit our own.
    const { url, seen } = await jobServer(succeeds(), {
      conflict: {
        error: "files: an extraction of this archive is already in progress",
        job_id: "other",
      },
    });
    const sum = await fast(url).extract("zip1");
    expect(sum.extracted).toBe(1);
    expect(seen.submissions).toBe(2);
    expect(seen.polls).toBeGreaterThanOrEqual(4);
  });

  it("extractAsync rejects the conflict at once, naming the job", async () => {
    const { url, seen } = await jobServer(succeeds(), {
      conflict: { error: "busy", job_id: "other" },
    });
    const err = await fast(url)
      .extractAsync("zip1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyConflictError);
    expect(err).toMatchObject({ jobId: "other", retryAfterMs: 30_000 });
    expect(seen.polls).toBe(0);
    // With retries off the blocking call gives up on the conflict too.
    const again = await jobServer(succeeds(), { conflict: { error: "busy", job_id: "other" } });
    await expect(fast(again.url, { retries: 0 }).extract("zip1")).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("outlives the small-call timeout: each request is bounded, the wait is not", async () => {
    const { url } = await jobServer([
      jobJson("running", 0, 2),
      jobJson("running", 0, 2),
      jobJson("running", 1, 2),
      ...succeeds(),
    ]);
    const cm = new CairnMark(url, { timeoutMs: 50, retries: 0, pollIntervalMs: 20 });
    const start = Date.now();
    await expect(cm.extract("zip1")).resolves.toMatchObject({ extracted: 1 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);

    const slow = await serve((req, res) => {
      setTimeout(() => sendJson(res, 200, jobJson("running")), 150);
    });
    await expect(
      new CairnMark(slow, { timeoutMs: 50, retries: 0 }).getMetadata("zip1"),
    ).rejects.toThrow();
  });

  it("aborting the signal stops the wait without cancelling the job", async () => {
    const { url, seen } = await jobServer([jobJson("running", 0, 2)]); // never finishes
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(fast(url).extract("zip1", { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(seen.cancels).toBe(0);
  });

  it("tells a failed job from a cancelled one", async () => {
    const failed = await jobServer([jobJson("failed", 1, 2, null, "files: store object: boom")]);
    const err = await fast(failed.url)
      .extract("zip1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionFailedError);
    expect(err).toBeInstanceOf(JobError);
    expect(err).not.toBeInstanceOf(ExtractionCancelledError);
    expect((err as ExtractionFailedError).job.error).toBe("files: store object: boom");
    expect((err as Error).message).toContain("boom");

    const cancelled = await jobServer([jobJson("cancelled", 1, 2, summary)]);
    const cerr = await fast(cancelled.url)
      .extract("zip1")
      .catch((e: unknown) => e);
    expect(cerr).toBeInstanceOf(ExtractionCancelledError);
    expect(cerr).not.toBeInstanceOf(ExtractionFailedError);
    // The partial summary rides along.
    expect((cerr as ExtractionCancelledError).job).toMatchObject({
      summary: parsedSummary,
      progress: { done: 1, total: 2 },
    });
  });

  it("job and cancelJob", async () => {
    const { url, seen } = await jobServer([jobJson("running", 1, 2)]);
    const cm = fast(url);
    const job = await cm.job("j1");
    expect(job).toMatchObject({ status: "running", progress: { done: 1, total: 2 } });
    expect(job.summary).toBeUndefined();
    const cancelled = await cm.cancelJob("j1");
    expect(seen.cancels).toBe(1);
    expect(cancelled).toMatchObject({ status: "cancelled", summary: parsedSummary });
    expect(cancelled.finishedAt).not.toBeNull();
  });

  it("a job purged past retention is NotFoundError", async () => {
    const url = await serve((req, res) =>
      sendJson(res, 404, { error: "files: extraction job not found" }),
    );
    await expect(fast(url, { retries: 0 }).waitForJob("old")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps a cap breach at submission to TooLargeError with the server's message", async () => {
    const url = await serve((req, res) =>
      sendJson(res, 413, { error: "archive exceeds the extraction limits: 1200 entries" }),
    );
    const cm = new CairnMark(url, { retries: 0 });
    await expect(cm.extract("zip1")).rejects.toMatchObject({
      constructor: TooLargeError,
      serverMessage: "archive exceeds the extraction limits: 1200 entries",
    });
  });
});
