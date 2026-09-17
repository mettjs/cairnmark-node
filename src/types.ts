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

/**
 * Whether files extracted from archives appear in a listing: together with
 * everything else (`include`, the default), hidden (`exclude`), or alone
 * (`only`). The archives themselves are found with `tags: { [TAG_ARCHIVE]: "true" }`.
 */
export type EntryScope = "include" | "exclude" | "only";

export interface ListFilter {
  /** Filter by exact MIME type. */
  contentType?: string;
  /** Filter by tag equality; multiple entries are ANDed. */
  tags?: Record<string, string>;
  /** Scope files extracted from archives; default `include`. */
  entries?: EntryScope;
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

/**
 * Tag keys the server writes on extracted archive entries and on archives.
 * Reserved — the server rejects any client writing a `cm:` key — but readable:
 * filter by them to find an archive's entries.
 */
/** On an extracted entry: the id of the archive it came from. */
export const TAG_ARCHIVE_ID = "cm:archive_id";
/** On an extracted entry: its full path inside the archive. */
export const TAG_ARCHIVE_PATH = "cm:archive_path";
/** On an extracted entry: its index in the archive's directory (a number). */
export const TAG_ARCHIVE_INDEX = "cm:archive_index";
/** On an archive that has been extracted, with the value "true". */
export const TAG_ARCHIVE = "cm:archive";

/**
 * One member of a stored zip, as read from its directory. `index` is the
 * handle to extract by: names need not be unique inside a zip, indexes are,
 * and the archive is immutable so an index stays valid.
 */
export interface ArchiveEntry {
  index: number;
  /** Full path inside the archive. */
  name: string;
  /** Uncompressed length in bytes. */
  size: number;
  /** From the name's extension; undefined when unknown (the server sniffs on extraction). */
  contentType?: string;
  /** The archive's own checksum of the content, hex-encoded. */
  crc32: string;
  /** false when the server would skip the entry; `reason` says why. */
  selectable: boolean;
  /** e.g. "platform_metadata", "encrypted", "unsupported_method". */
  reason?: string;
}

export function parseArchiveEntries(data: any): ArchiveEntry[] {
  return (data.entries ?? []).map((e: any): ArchiveEntry => ({
    index: e.index,
    name: e.name,
    size: e.size,
    contentType: e.content_type ?? undefined,
    crc32: e.crc32,
    selectable: !!e.selectable,
    reason: e.reason ?? undefined,
  }));
}

/** One skipped entry and why. */
export interface SkippedEntry {
  index: number;
  name: string;
  reason: string;
}

/**
 * The server's bounded report of one extraction. It never lists the files
 * created: enumerate them with `listAll` and a `TAG_ARCHIVE_ID` filter.
 */
export interface ExtractSummary {
  archiveId: string;
  /** Entries in the archive's directory. */
  entries: number;
  extracted: number;
  skipped: number;
  /** Skips per reason ("platform_metadata", "already_extracted", "not_selected", …). */
  skippedByReason: Record<string, number>;
  /** The first skipped entries (at most 20). */
  sampleSkipped: SkippedEntry[];
}

export function parseExtractSummary(data: any): ExtractSummary {
  return {
    archiveId: data.archive_id,
    entries: data.entries,
    extracted: data.extracted,
    skipped: data.skipped,
    skippedByReason: data.skipped_by_reason ?? {},
    sampleSkipped: (data.sample_skipped ?? []).map((s: any): SkippedEntry => ({
      index: s.index,
      name: s.name,
      reason: s.reason,
    })),
  };
}

export interface ExtractOptions {
  /**
   * Restrict the run to these directory indexes (from `archiveEntries`).
   * Undefined extracts every selectable entry; an empty array extracts
   * nothing. An index outside the directory rejects with InvalidRequestError.
   */
  entries?: number[];
  signal?: AbortSignal;
}
