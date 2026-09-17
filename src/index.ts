/**
 * Official Node.js client for the CairnMark file service.
 *
 * ```ts
 * import { CairnMark } from "cairnmark";
 *
 * const cm = new CairnMark("http://localhost:8080");
 * const f = await cm.upload("hello", {
 *   filename: "hello.txt",
 *   metadata: { env: "demo" },
 *   idempotencyKey: "auto",
 * });
 * await cm.downloadToFile(f.id, "hello-copy.txt"); // checksum-verified
 * for await (const file of cm.listAll({ tags: { env: "demo" } })) {
 *   // ...
 * }
 * const summary = await cm.extract(archive.id); // a server-side job, waited for
 * ```
 */

export { CairnMark, VERSION, type ClientOptions } from "./client.js";
export {
  APIError,
  CairnMarkError,
  ChecksumMismatchError,
  IdempotencyConflictError,
  IdempotencyGoneError,
  InvalidRequestError,
  NotArchiveError,
  NotFoundError,
  RangeNotSatisfiableError,
  ServerError,
  TooLargeError,
} from "./errors.js";
export {
  ExtractionCancelledError,
  ExtractionFailedError,
  JobError,
  TERMINAL_JOB_STATUSES,
  isTerminal,
  type Job,
  type JobProgress,
  type JobStatus,
} from "./jobs.js";
export { TAG_ARCHIVE, TAG_ARCHIVE_ID, TAG_ARCHIVE_INDEX, TAG_ARCHIVE_PATH } from "./types.js";
export type {
  ArchiveEntry,
  Download,
  DownloadOptions,
  EntryScope,
  ExtractOptions,
  ExtractSummary,
  FileRecord,
  ListFilter,
  ListPage,
  SkippedEntry,
  UploadBody,
  UploadContent,
  UploadOptions,
} from "./types.js";
