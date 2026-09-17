# cairnmark-node

The official Node.js client for [CairnMark](https://github.com/mettjs/cairnmark) —
a self-hostable file service over S3-compatible storage with a queryable
Postgres metadata layer.

TypeScript, **zero runtime dependencies** (global `fetch` + Web Streams).
Streaming uploads/downloads, client-side checksum verification, typed errors,
safe retries, async-iterator pagination. Node ≥ 18, ESM. Requires a CairnMark
server with extraction jobs — the first server release after v1.2.0, which
carries the `extraction_jobs` migration; every method except the archive ones
also works against a server ≥ v1.1.0.

```sh
npm install cairnmark   # not yet on npm — until then: npm install <path to this repo>
```

## Quickstart

```ts
import { CairnMark } from "cairnmark";

const cm = new CairnMark("http://localhost:8080");

// Upload with tags; idempotencyKey: "auto" makes retries duplicate-safe.
const f = await cm.upload("hello from Node", {
  filename: "hello.txt",
  contentType: "text/plain",
  metadata: { env: "demo" },
  idempotencyKey: "auto",
});
console.log("uploaded:", f.id);

// Download — follows the presign redirect and verifies the SHA-256.
await cm.downloadToFile(f.id, "hello-copy.txt");

// Search by tag, lazily across pages.
for await (const file of cm.listAll({ tags: { env: "demo" } })) {
  console.log("found:", file.id, file.filename);
}
```

## Methods

| Method | Does |
|---|---|
| `upload(content, options)` | Stream a `string` \| `Uint8Array` \| `Blob` \| `ReadableStream` (or a factory returning one) up. `idempotencyKey: "auto"` generates a key. |
| `uploadFile(path, options)` | Upload from disk; name and size inferred, retry-safe via a stream factory. |
| `download(id, options)` | `{ stream, file }`. Default follows the presign redirect; `offset`/`length` for a 206 range; `verify` for checksum checking. |
| `downloadToFile(id, path)` | Download to disk, checksum-verified; removes the file on failure. |
| `presignUrl(id)` | Mint the presigned object-store URL without following it. |
| `getMetadata(id)` | Fetch the file record (camel-cased `FileRecord`; ISO-string dates). |
| `updateMetadata(id, tags, { mode })` | Patch tags; `mode: "merge"` (default) or `"replace"`. |
| `delete(id)` | Soft-delete. |
| `list(filter)` / `listAll(filter)` | One page / `for await` over every match. `entries` scopes files extracted from archives. |
| `archiveEntries(id)` | List a stored zip's entries by index, each selectable or carrying a skip reason. Writes nothing. |
| `extract(id, { entries, signal })` | Store a zip's entries (all, or `entries` by index) as files and wait for it; resolves to a bounded summary. |
| `extractAsync(id, { entries })` | Submit the same extraction and resolve to the pending `Job` at once. |
| `job(jobId)` / `waitForJob(jobId, { signal })` | Read a job's state / poll it to a terminal state. |
| `cancelJob(jobId)` | Ask a job to stop after the entry it is on; idempotent. |
| `health()` / `ready()` | Liveness / readiness probes (reject on failure). |

## Archives

A zip uploads like any other file. Extraction is a second, explicit call
against the stored object; each extracted entry becomes an ordinary file,
tagged with the archive it came from.

```ts
import { CairnMark, TAG_ARCHIVE_ID, TAG_ARCHIVE_PATH } from "cairnmark";

// 1. Upload the zip and see what is inside — nothing is written yet.
const arch = await cm.uploadFile("docs.zip", { idempotencyKey: "auto" });
for (const e of await cm.archiveEntries(arch.id)) {
  console.log(e.index, e.name, e.size, e.selectable, e.reason);
}

// 2. Extract one entry by index (omit `entries` to extract everything selectable).
const sum = await cm.extract(arch.id, { entries: [0] });
console.log("extracted", sum.extracted, "skipped", sum.skippedByReason);

// 3. Find the extracted file by its tags, then download it like any other.
for await (const f of cm.listAll({
  tags: { [TAG_ARCHIVE_ID]: arch.id, [TAG_ARCHIVE_PATH]: "reports/q3.pdf" },
})) {
  await cm.downloadToFile(f.id, "q3.pdf");
}
```

Entries are addressed by **index** because names need not be unique inside a
zip. Extraction is resumable: a re-run skips entries already stored
(`already_extracted`) and never resurrects one you deleted
(`previously_deleted`).

**The server runs an extraction as a job.** `extract` hides that: it submits,
polls, and resolves to the summary, blocking for the whole run — bounded by
its `AbortSignal` alone, while `timeoutMs` bounds each request it makes.
Aborting stops the wait without cancelling the job. If another extraction of
the same archive is in flight (`409`), it waits for that job to finish and
resubmits its own. A job that fails rejects with `ExtractionFailedError`; one
that is cancelled rejects with `ExtractionCancelledError` carrying the partial
summary — distinct, so "I cancelled this" and "it broke" are told apart.

The job surface is there when you want it — to return early, show progress,
or cancel:

```ts
let job = await cm.extractAsync(arch.id);   // 202, at once
// ... later, or elsewhere, with just the id:
job = await cm.job(job.id);                 // .status, .progress.done / .progress.total
job = await cm.cancelJob(job.id);           // stops after the current entry; keeps what is stored
job = await cm.waitForJob(job.id);          // polls (1s, doubling to 10s) until terminal; inspect .status
```

A finished job stays readable for the server's `CAIRNMARK_JOB_RETENTION`
(default 24h), after which `job` rejects with `NotFoundError`; the extracted
files themselves are permanent. Errors a synchronous call could give — not a
zip, a bad selection, over a cap — still come back from the submission itself.

`list` mixes ordinary files, archives and extracted entries;
`entries: "exclude" | "only"` separates them, and
`tags: { [TAG_ARCHIVE]: "true" }` lists the archives.

Every method accepts an `AbortSignal` via its options.

## Configuration

`new CairnMark(baseUrl, options)` options:

| Option | Default | Does |
|---|---|---|
| `headers` | — | Default headers on every request; the hook for gateway credentials. |
| `timeoutMs` | none | Bounds each small call (metadata, tag updates, delete, list, presign, health, and each request of an extraction). Streams and the wait for a job are exempt — bound those with an `AbortSignal`. |
| `retries` | `2` | Retries after a network error or 5xx (so up to `retries + 1` attempts), and how many `409`s `extract` waits out before giving up. `0` disables. |
| `pollIntervalMs` | `1000` | The first wait between polls of an extraction job; each wait doubles up to `10000`. |
| `userAgent` | `cairnmark-node/<version>` | Override the `User-Agent`. |
| `fetch` | global `fetch` | Replace the fetch implementation — custom undici dispatchers, instrumentation, tests. |

## Errors

Every non-2xx response rejects with a subclass of `APIError` (carrying
`.status`, `.serverMessage`, `.retryAfterMs` on 409, and `.jobId` on a 409
extraction conflict — the job holding the archive), itself a `CairnMarkError`:

`InvalidRequestError` (400) · `NotFoundError` (404, a file or a job) ·
`IdempotencyConflictError` (409) · `IdempotencyGoneError` (410) ·
`TooLargeError` (413) · `NotArchiveError` (415, an archive method on a file
that is not a zip) · `RangeNotSatisfiableError` (416) · `ServerError` (5xx)
— plus `ChecksumMismatchError`, which errors a verified download stream, and
from `extract`: `ExtractionFailedError` / `ExtractionCancelledError` (both
`JobError`, carrying the terminal `.job`).

## Semantics worth knowing

- **Retries.** Network errors and 5xx are retried with jittered backoff
  (default 2 retries; `retries` option). Uploads retry **only** when they
  carry an idempotency key *and* the body is reusable — in-memory content or
  a factory function; a one-shot `ReadableStream` is sent exactly once. A 409
  (same key still in flight) waits out the server's `Retry-After`.
- **Checksum verification.** The presigned object-store response carries no
  checksum header, so `verify: true` pipes the stream through a hashing
  `TransformStream` and errors it with `ChecksumMismatchError` after the last
  chunk if it doesn't match the stored SHA-256 (fetched from metadata). Range
  downloads can't be verified.
- **Timeouts.** `timeoutMs` bounds small calls (metadata, list, delete,
  presign, health, each request of an extraction) only; uploads, download
  streams and the wait for an extraction job are bounded by their
  `AbortSignal` so large transfers and long runs aren't cut off.
- **Extraction jobs.** `extract` is `extractAsync` + `waitForJob`. It waits
  out another job on the same archive and resubmits; the SDK never resolves
  someone else's summary as yours. A job's result is readable for the
  server's retention window only; the extracted files are permanent.
- **Auth.** The server has none; put it behind your gateway and inject
  credentials with the `headers` option (or a custom `fetch`).

## Development

```sh
npm install
npm test                         # unit tests (real local HTTP servers)
npm run lint && npm run typecheck
npm run build                    # tsup → dist/ (ESM + .d.ts)

# integration: full round-trip against a live server
(cd ../CairnMark && docker compose up -d --build)
npm run test:integration         # honors CAIRNMARK_BASE_URL, default localhost:8080
```

## License

[MIT](LICENSE) © 2026 Michael Ramirez
