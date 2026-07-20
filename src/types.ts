/** Public data models and option shapes. */

/**
 * A stored file's metadata record, camel-cased from the server's JSON.
 * (Named FileRecord because `File` is already a Node/web global.)
 */
export interface FileRecord {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Hex SHA-256 computed by the server during upload; undefined if absent. */
  checksumSha256?: string;
  /** The queryable tag set (arbitrary JSON values). */
  metadata: Record<string, unknown>;
  /** RFC 3339 timestamp, e.g. "2026-01-01T00:00:00Z". */
  createdAt: string;
  /**
   * null until the file's tags are first changed — a quick way to tell an
   * untouched original from an edited record.
   */
  updatedAt: string | null;
}

export function parseFile(data: any): FileRecord {
  return {
    id: data.id,
    filename: data.filename,
    contentType: data.content_type,
    sizeBytes: data.size_bytes,
    checksumSha256: data.checksum_sha256 ?? undefined,
    metadata: data.metadata ?? {},
    createdAt: data.created_at,
    updatedAt: data.updated_at ?? null,
  };
}

/**
 * One page of list results. A defined `nextCursor` means more may follow;
 * its absence is the definitive end-of-list signal.
 */
export interface ListPage {
  files: FileRecord[];
  limit: number;
  count: number;
  nextCursor?: string;
}

export function parseListPage(data: any): ListPage {
  return {
    files: (data.files ?? []).map(parseFile),
    limit: data.limit,
    count: data.count,
    nextCursor: data.next_cursor ?? undefined,
  };
}

export interface ListFilter {
  /** Filter by exact MIME type. */
  contentType?: string;
  /** Filter by tag equality; multiple entries are ANDed. */
  tags?: Record<string, string>;
  /** Page size (server default 50, max 500; the server clamps and echoes). */
  limit?: number;
  /** Resume after a previous page — pass ListPage.nextCursor. */
  cursor?: string;
  signal?: AbortSignal;
}

/** A single upload body, or a factory producing a fresh one per attempt. */
export type UploadBody = string | Uint8Array | Blob | ReadableStream<Uint8Array>;
export type UploadContent = UploadBody | (() => UploadBody);

export interface UploadOptions {
  /** User-facing name; the server defaults it to the file's id. */
  filename?: string;
  /** MIME type; the server sniffs it when empty. */
  contentType?: string;
  /**
   * Byte length of a stream body, sent as Content-Length so the server can
   * reject oversized uploads up front (in-memory bodies get one automatically;
   * without it streams are sent chunked, which also works).
   */
  size?: number;
  /** Initial tag set, sent as an X-Metadata JSON header. */
  metadata?: Record<string, unknown>;
  /**
   * Makes a retried upload return the original result instead of duplicating
   * (max 255 chars). "auto" generates a unique key. Required for the SDK to
   * auto-retry.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface DownloadOptions {
  /**
   * Hash the stream and error it with ChecksumMismatchError if the bytes
   * don't match the stored SHA-256. Incompatible with a range.
   */
  verify?: boolean;
  /** Byte range start (with `length` undefined: to the end). */
  offset?: number;
  /** Byte range length. */
  length?: number;
  signal?: AbortSignal;
}

/** An open download stream plus the file's metadata record. */
export interface Download {
  stream: ReadableStream<Uint8Array>;
  file: FileRecord;
}
