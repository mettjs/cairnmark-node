/**
 * Every `node:` import lives here, so a future browser/edge build can swap
 * this module out. (Browser support is not a v1 goal.)
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ChecksumMismatchError } from "./errors.js";

export { basename };

/** 32 hex chars, unique per call — comfortably under the server's 255 cap. */
export function newIdempotencyKey(): string {
  return randomUUID().replaceAll("-", "");
}

/**
 * A pass-through that hashes the bytes and errors the stream with
 * ChecksumMismatchError after the last chunk if the digest differs. The
 * presigned object-store response carries no checksum header, so this
 * client-side hash is the only integrity signal on an offloaded download.
 */
export function verifyStream(expected: string): TransformStream<Uint8Array, Uint8Array> {
  const hash = createHash("sha256");
  return new TransformStream({
    transform(chunk, controller) {
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      const got = hash.digest("hex");
      if (got !== expected.toLowerCase()) throw new ChecksumMismatchError(got, expected);
    },
  });
}

export function fileReadStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

/** Write the stream to `path`, removing the partial file on any failure. */
export async function writeStreamToFile(
  stream: ReadableStream<Uint8Array>,
  path: string,
): Promise<void> {
  try {
    await pipeline(Readable.fromWeb(stream as any), createWriteStream(path));
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
}
