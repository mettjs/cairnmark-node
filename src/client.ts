import { CairnMarkError, IdempotencyConflictError } from "./errors.js";
import {
  anySignal,
  backoffDelayMs,
  errorFromResponse,
  filePath,
  listQuery,
  rangeHeader,
  retryDelayMs,
  sleep,
  sleepAbortable,
  unexpectedStatus,
} from "./http.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  isTerminal,
  jobError,
  jobPath,
  nextPollDelayMs,
  parseJob,
  type Job,
} from "./jobs.js";
import {
  basename,
  fileReadStream,
  fileSize,
  newIdempotencyKey,
  verifyStream,
  writeStreamToFile,
} from "./node.js";
import {
  parseArchiveEntries,
  parseFile,
  parseListPage,
  type ArchiveEntry,
  type Download,
  type DownloadOptions,
  type ExtractOptions,
  type ExtractSummary,
  type FileRecord,
  type ListFilter,
  type ListPage,
  type UploadBody,
  type UploadContent,
  type UploadOptions,
} from "./types.js";

export const VERSION = "1.0.0";

export interface ClientOptions {
  /**
   * Default headers on every request — the hook for gateway credentials,
   * since the server itself has no auth.
   */
  headers?: Record<string, string>;
  /**
   * Bounds each small API call (metadata, tag updates, delete, list, presign,
   * health, and every request an extraction makes). Uploads and download
   * streams are exempt — a fixed timeout would cut off large transfers — and
   * are bounded only by their AbortSignal; so is the wait for an extraction
   * job as a whole.
   */
  timeoutMs?: number;
  /**
   * How many times a retryable request is reissued after a network error or
   * 5xx (default 2, i.e. up to 3 attempts), and how many 409s `extract` waits
   * out before giving up. 0 disables retries. Uploads retry only when they
   * carry an idempotency key and a reusable body.
   */
  retries?: number;
  /**
   * The first wait between polls of an extraction job (default 1000); each
   * wait doubles up to a 10s ceiling. Lower it in tests, or when jobs are
   * known to be short.
   */
  pollIntervalMs?: number;
  userAgent?: string;
  /** Replace the fetch implementation (custom dispatchers, tests). */
  fetch?: typeof fetch;
}

interface RequestOpts {
  method: string;
  path: string;
  expect: number;
  headers?: Record<string, string>;
  body?: UploadContent;
  redirect?: "follow" | "manual" | "error";
  retryable?: boolean;
  retry409?: boolean;
  applyTimeout?: boolean;
  signal?: AbortSignal;
}

/** Client for one CairnMark server. Safe for concurrent use. */
export class CairnMark {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #retries: number;
  readonly #timeoutMs?: number;
  readonly #pollIntervalMs: number;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    new URL(baseUrl); // reject malformed base URLs up front
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#headers = {
      ...options.headers,
      "user-agent": options.userAgent ?? `cairnmark-node/${VERSION}`,
    };
    this.#retries = options.retries ?? 2;
    this.#timeoutMs = options.timeoutMs;
    this.#pollIntervalMs =
      options.pollIntervalMs && options.pollIntervalMs > 0
        ? options.pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  // -- core request loop ---------------------------------------------------

  async #request(o: RequestOpts): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      // A factory body is invoked fresh per attempt (retries need a new stream).
      const body: UploadBody | undefined = typeof o.body === "function" ? o.body() : o.body;
      const timeoutSignal =
        o.applyTimeout && this.#timeoutMs ? AbortSignal.timeout(this.#timeoutMs) : undefined;
      const init: RequestInit & { duplex?: "half" } = {
        method: o.method,
        headers: { ...this.#headers, ...o.headers },
        redirect: o.redirect ?? "manual",
        signal: anySignal(o.signal, timeoutSignal),
      };
      if (body !== undefined) {
        init.body = body;
        if (body instanceof ReadableStream) init.duplex = "half";
      }

      let res: Response;
      try {
        res = await this.#fetch(this.#baseUrl + o.path, init);
      } catch (err) {
        if (o.retryable && attempt < this.#retries && !o.signal?.aborted) {
          await sleep(backoffDelayMs(attempt));
          continue;
        }
        throw err;
      }
      if (res.status < 400) {
        if (res.status !== o.expect) {
          await res.body?.cancel().catch(() => {});
          throw unexpectedStatus(res, o.expect);
        }
        return res;
      }

      const err = await errorFromResponse(res);
      const retry =
        (o.retryable === true && res.status >= 500) || (o.retry409 === true && res.status === 409);
      if (retry && attempt < this.#retries) {
        await sleep(retryDelayMs(res.status === 409 ? err : undefined, attempt));
        continue;
      }
      throw err;
    }
  }

  // -- uploads ---------------------------------------------------------------

  /**
   * Stream `content` up and return the new file's record.
   *
   * Retries (network error, 5xx, or a 409 replay conflict) happen only when
   * the options carry an idempotency key and the body is reusable — a string,
   * Uint8Array, Blob, or a factory function producing a fresh stream.
   * A one-shot ReadableStream is sent exactly once.
   */
  async upload(content: UploadContent, options: UploadOptions = {}): Promise<FileRecord> {
    const key = options.idempotencyKey === "auto" ? newIdempotencyKey() : options.idempotencyKey;
    const headers: Record<string, string> = {};
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      // The X-Metadata JSON header carries typed/nested tag values intact.
      headers["x-metadata"] = JSON.stringify(options.metadata);
    }
    if (key) headers["idempotency-key"] = key;
    const inMemory =
      typeof content === "string" || content instanceof Uint8Array || content instanceof Blob;
    if (options.size && options.size > 0 && !inMemory) {
      // fetch sets Content-Length for in-memory bodies; a stream would
      // otherwise go chunked, denying the server its up-front size check.
      headers["content-length"] = String(options.size);
    }

    const path =
      "/files" + (options.filename ? `?filename=${encodeURIComponent(options.filename)}` : "");
    const reusable = inMemory || typeof content === "function";
    const res = await this.#request({
      method: "POST",
      path,
      headers,
      body: content,
      expect: 201,
      retryable: !!key && reusable,
      retry409: !!key && reusable,
      signal: options.signal,
    });
    return parseFile(await res.json());
  }

  /** Upload the file at `path`; name and size are inferred. */
  async uploadFile(path: string, options: Omit<UploadOptions, "size"> = {}): Promise<FileRecord> {
    const size = await fileSize(path);
    // A factory body makes retries safe: each attempt reads the file afresh.
    return this.upload(() => fileReadStream(path), {
      ...options,
      size,
      filename: options.filename ?? basename(path),
    });
  }

  // -- downloads --------------------------------------------------------------

  /**
   * Open the file's content for reading. Full downloads follow the server's
   * 302 redirect to a presigned object-store URL, so bytes flow from the
   * store directly; `offset`/`length` request a 206 range through the server.
   */
  async download(fileId: string, options: DownloadOptions = {}): Promise<Download> {
    const ranged = options.offset !== undefined || options.length !== undefined;
    if (options.verify && ranged) {
      throw new CairnMarkError("verify is incompatible with a range download");
    }

    // The metadata record supplies the stored checksum for verification and
    // rounds out the result either way.
    const file = await this.getMetadata(fileId, { signal: options.signal });
    if (options.verify && !file.checksumSha256) {
      throw new CairnMarkError(`file ${fileId} has no stored checksum to verify against`);
    }

    const res = await this.#request({
      method: "GET",
      path: filePath(fileId),
      headers: ranged ? { range: rangeHeader(options.offset ?? 0, options.length) } : undefined,
      redirect: "follow",
      expect: ranged ? 206 : 200,
      retryable: true,
      signal: options.signal,
    });
    let stream = res.body ?? emptyStream();
    if (options.verify && file.checksumSha256) {
      stream = stream.pipeThrough(verifyStream(file.checksumSha256));
    }
    return { stream, file };
  }

  /**
   * Download into `path` (created or truncated), checksum-verified by
   * default. On any failure — including a mismatch — the partial file is
   * removed.
   */
  async downloadToFile(
    fileId: string,
    path: string,
    options: { verify?: boolean; signal?: AbortSignal } = {},
  ): Promise<FileRecord> {
    const dl = await this.download(fileId, {
      verify: options.verify ?? true,
      signal: options.signal,
    });
    await writeStreamToFile(dl.stream, path);
    return dl.file;
  }

  /**
   * The presigned object-store URL for the file, without following it — hand
   * it to a browser or another service. It expires after the server's
   * configured TTL, and its host is only as reachable as the server's
   * CAIRNMARK_S3_PUBLIC_ENDPOINT makes it.
   */
  async presignUrl(fileId: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const res = await this.#request({
      method: "GET",
      path: filePath(fileId),
      redirect: "manual",
      expect: 302,
      retryable: true,
      applyTimeout: true,
      signal: options.signal,
    });
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (!location) throw new CairnMarkError("presign response has no Location header");
    return location;
  }

  // -- metadata ---------------------------------------------------------------

  /** Fetch the metadata record for `fileId`. */
  async getMetadata(fileId: string, options: { signal?: AbortSignal } = {}): Promise<FileRecord> {
    const res = await this.#request({
      method: "GET",
      path: filePath(fileId) + "/metadata",
      expect: 200,
      retryable: true,
      applyTimeout: true,
      signal: options.signal,
    });
    return parseFile(await res.json());
  }

  /** Merge (default) or replace (`mode: "replace"`) the file's tags. */
  async updateMetadata(
    fileId: string,
    tags: Record<string, unknown>,
    options: { mode?: "merge" | "replace"; signal?: AbortSignal } = {},
  ): Promise<FileRecord> {
    const mode = options.mode ?? "merge";
    if (mode !== "merge" && mode !== "replace") {
      throw new CairnMarkError(`mode must be "merge" or "replace", not ${JSON.stringify(mode)}`);
    }
    const res = await this.#request({
      method: "PATCH",
      path: filePath(fileId) + "/metadata" + (mode === "replace" ? "?mode=replace" : ""),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tags),
      expect: 200,
      retryable: true, // same tags applied twice land in the same state
      applyTimeout: true,
      signal: options.signal,
    });
    return parseFile(await res.json());
  }

  /** Soft-delete `fileId`; the stored object is purged asynchronously. */
  async delete(fileId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const res = await this.#request({
      method: "DELETE",
      path: filePath(fileId),
      expect: 204,
      retryable: true,
      applyTimeout: true,
      signal: options.signal,
    });
    await res.text();
  }

  // -- listing ------------------------------------------------------------------

  /** One page of files matching the filter, newest first. */
  async list(filter: ListFilter = {}): Promise<ListPage> {
    if (filter.entries && !["include", "exclude", "only"].includes(filter.entries)) {
      throw new CairnMarkError(
        `entries must be "include", "exclude" or "only", not ${JSON.stringify(filter.entries)}`,
      );
    }
    const res = await this.#request({
      method: "GET",
      path: "/files" + listQuery(filter),
      expect: 200,
      retryable: true,
      applyTimeout: true,
      signal: filter.signal,
    });
    return parseListPage(await res.json());
  }

  /** Every file matching the filter, fetching pages lazily. */
  async *listAll(filter: ListFilter = {}): AsyncGenerator<FileRecord, void, void> {
    let cursor = filter.cursor;
    for (;;) {
      const page = await this.list({ ...filter, cursor });
      yield* page.files;
      // A page without a cursor is the last (a final empty page is normal
      // when the total is an exact multiple of the page size).
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  // -- archives ---------------------------------------------------------------

  /**
   * List the entries of the zip stored as `fileId`, each marked selectable or
   * carrying the reason the server would skip it. Nothing is written.
   * Rejects with NotArchiveError if the file is not a zip, TooLargeError if it
   * has more entries than the server's cap, or a central directory larger than
   * the server will parse.
   */
  async archiveEntries(
    fileId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ArchiveEntry[]> {
    const res = await this.#request({
      method: "GET",
      path: filePath(fileId) + "/archive",
      expect: 200,
      retryable: true,
      applyTimeout: true,
      signal: options.signal,
    });
    return parseArchiveEntries(await res.json());
  }

  /**
   * Store the zip's entries as ordinary files — each tagged with
   * TAG_ARCHIVE_ID, TAG_ARCHIVE_PATH and TAG_ARCHIVE_INDEX — and resolve to
   * the summary once the extraction has finished.
   *
   * The server runs an extraction as a job; this is `extractAsync` followed
   * by `waitForJob`, kept as one call because most callers want exactly that.
   * The call blocks for the whole run and is bounded by its AbortSignal alone
   * — `timeoutMs` bounds each request it makes, not the wait — and aborting
   * stops waiting without cancelling the job (`cancelJob` does that). Another
   * extraction of the same archive in flight is waited out and this one then
   * resubmitted, since extraction resumes past entries already stored and the
   * other job's selection may not be ours; a re-run after success is a no-op
   * that reports every entry as already_extracted. A job that fails rejects
   * with ExtractionFailedError; one that is cancelled rejects with
   * ExtractionCancelledError carrying the partial summary.
   */
  async extract(fileId: string, options: ExtractOptions = {}): Promise<ExtractSummary> {
    let job = await this.#submitWaitingOutConflicts(fileId, options);
    job = await this.waitForJob(job.id, { signal: options.signal });
    if (job.status !== "succeeded") throw jobError(job);
    if (!job.summary) {
      throw new CairnMarkError(`extraction job ${job.id} succeeded without a summary`);
    }
    return job.summary;
  }

  /**
   * Submit an extraction and resolve to the pending job without waiting.
   * Everything that can be refused up front is refused now, with the errors a
   * synchronous run gave — NotArchiveError, TooLargeError, InvalidRequestError
   * for a selection out of range — so a job only fails on what could not be
   * known at submission. Another job for the same archive still pending or
   * running rejects with IdempotencyConflictError, whose `jobId` names it:
   * poll that one, or wait for it and resubmit, which is what `extract` does.
   */
  async extractAsync(fileId: string, options: ExtractOptions = {}): Promise<Job> {
    const selected = options.entries !== undefined;
    const res = await this.#request({
      method: "POST",
      path: filePath(fileId) + "/extract",
      headers: selected ? { "content-type": "application/json" } : undefined,
      body: selected ? JSON.stringify({ entries: options.entries }) : undefined,
      expect: 202,
      retryable: true,
      applyTimeout: true,
      signal: options.signal,
    });
    return parseJob(await res.json());
  }

  /**
   * The job's current state. Rejects with NotFoundError once the server has
   * purged it — CAIRNMARK_JOB_RETENTION after it finished — so a poller
   * slower than that loses the result; the extracted files are permanent.
   */
  async job(jobId: string, options: { signal?: AbortSignal } = {}): Promise<Job> {
    const res = await this.#request({
      method: "GET",
      path: jobPath(jobId),
      expect: 200,
      retryable: true,
      applyTimeout: true,
      signal: options.signal,
    });
    return parseJob(await res.json());
  }

  /**
   * Ask the job to stop and resolve to its state after the request. A pending
   * job is cancelled at once; a running one stops after the entry it is
   * writing and keeps the entries stored so far, so a later `extract` resumes
   * past them; a finished job comes back unchanged. Idempotent.
   */
  async cancelJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<Job> {
    const res = await this.#request({
      method: "POST",
      path: jobPath(jobId) + "/cancel",
      expect: 202,
      retryable: true,
      applyTimeout: true,
      signal: options.signal,
    });
    return parseJob(await res.json());
  }

  /**
   * Poll until the job is terminal and resolve to it whatever the outcome —
   * inspect `status`, or let `extract` turn a failure or a cancellation into
   * an error. Polls every `pollIntervalMs`, doubling to a 10s ceiling; the
   * signal bounds the wait, and aborting it does not cancel the job.
   */
  async waitForJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<Job> {
    let delay = this.#pollIntervalMs;
    for (;;) {
      const job = await this.job(jobId, options);
      if (isTerminal(job.status)) return job;
      await sleepAbortable(delay, options.signal);
      delay = nextPollDelayMs(delay, this.#pollIntervalMs);
    }
  }

  /**
   * extractAsync that, on a 409, waits for the job holding the archive to end
   * — whatever its outcome — and resubmits, up to `retries` times. Waiting on
   * that job beats sleeping out Retry-After: it is exactly as long as needed
   * and never longer.
   */
  async #submitWaitingOutConflicts(fileId: string, options: ExtractOptions): Promise<Job> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.extractAsync(fileId, options);
      } catch (err) {
        if (!(err instanceof IdempotencyConflictError) || attempt >= this.#retries) throw err;
        if (err.jobId) {
          // A 404 (purged already) or any other failure to observe it means
          // the archive is, or is about to be, free; only an abort stops us.
          await this.waitForJob(err.jobId, { signal: options.signal }).catch((e: unknown) => {
            if (options.signal?.aborted) throw e;
          });
        } else {
          await sleepAbortable(retryDelayMs(err, attempt), options.signal);
        }
      }
    }
  }

  // -- probes -----------------------------------------------------------------

  /** Rejects unless the server answers 200 on /healthz (liveness). */
  async health(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.#check("/healthz", options.signal);
  }

  /** Rejects unless /readyz says storage and database are reachable. */
  async ready(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.#check("/readyz", options.signal);
  }

  async #check(path: string, signal?: AbortSignal): Promise<void> {
    const res = await this.#request({
      method: "GET",
      path,
      expect: 200,
      retryable: true,
      applyTimeout: true,
      signal,
    });
    await res.text();
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
