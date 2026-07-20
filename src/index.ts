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
  NotFoundError,
  RangeNotSatisfiableError,
  ServerError,
  TooLargeError,
} from "./errors.js";
export type {
  Download,
  DownloadOptions,
  FileRecord,
  ListFilter,
  ListPage,
  UploadBody,
  UploadContent,
  UploadOptions,
} from "./types.js";
