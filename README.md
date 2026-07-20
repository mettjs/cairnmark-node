# cairnmark-node

The official Node.js client for [CairnMark](https://github.com/mettjs/cairnmark) —
a self-hostable file service over S3-compatible storage with a queryable
Postgres metadata layer.

TypeScript, **zero runtime dependencies** (global `fetch` + Web Streams).
Streaming uploads/downloads, client-side checksum verification, typed errors,
safe retries, async-iterator pagination. Node ≥ 18, ESM. Requires a CairnMark
server ≥ v1.1.0 (cursor pagination and 409 `Retry-After`).

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
| `list(filter)` / `listAll(filter)` | One page / `for await` over every match. |
| `health()` / `ready()` | Liveness / readiness probes (reject on failure). |

Every method accepts an `AbortSignal` via its options.

## Configuration

`new CairnMark(baseUrl, options)` options:

| Option | Default | Does |
|---|---|---|
| `headers` | — | Default headers on every request; the hook for gateway credentials. |
| `timeoutMs` | none | Bounds each small call (metadata, tag updates, delete, list, presign, health). Streams are exempt — bound those with an `AbortSignal`. |
| `retries` | `2` | Retries after a network error or 5xx (so up to `retries + 1` attempts). `0` disables. |
| `userAgent` | `cairnmark-node/<version>` | Override the `User-Agent`. |
| `fetch` | global `fetch` | Replace the fetch implementation — custom undici dispatchers, instrumentation, tests. |

## Errors

Every non-2xx response rejects with a subclass of `APIError` (carrying
`.status`, `.serverMessage`, and `.retryAfterMs` on 409), itself a
`CairnMarkError`:

`InvalidRequestError` (400) · `NotFoundError` (404) ·
`IdempotencyConflictError` (409) · `IdempotencyGoneError` (410) ·
`TooLargeError` (413) · `RangeNotSatisfiableError` (416) · `ServerError` (5xx)
— plus `ChecksumMismatchError`, which errors a verified download stream.

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
  presign, health) only; uploads and download streams are bounded by their
  `AbortSignal` so large transfers aren't cut off.
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
