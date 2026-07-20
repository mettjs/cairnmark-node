/** Pure request/response helpers shared across the client's operations. */

import { APIError, errorClassFor } from "./errors.js";
import type { ListFilter } from "./types.js";

/** Cap on how long a retry waits on a server-supplied Retry-After. */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Exponential, jittered delay in ms before retry `attempt` (0-based). */
export function backoffDelayMs(attempt: number): number {
  const d = Math.min(250 * 2 ** attempt, 4_000);
  return d / 2 + Math.random() * (d / 2);
}

/** Backoff, except a server-supplied Retry-After (bounded) wins. */
export function retryDelayMs(err: APIError | undefined, attempt: number): number {
  if (err?.retryAfterMs) return Math.min(err.retryAfterMs, MAX_RETRY_AFTER_MS);
  return backoffDelayMs(attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a non-2xx response to a typed APIError, consuming the body. */
export async function errorFromResponse(res: Response): Promise<APIError> {
  let message = "";
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      message = typeof body?.error === "string" ? body.error : "";
    } catch {
      message = text.trim();
    }
  } catch {
    // Unreadable body; fall through to the status line.
  }
  if (!message) message = `HTTP ${res.status}`;
  const ra = res.headers.get("retry-after") ?? "";
  const retryAfterMs = /^\d+$/.test(ra) && Number(ra) > 0 ? Number(ra) * 1000 : undefined;
  return new (errorClassFor(res.status))(res.status, message, retryAfterMs);
}

export function unexpectedStatus(res: Response, want: number): APIError {
  return new APIError(res.status, `unexpected status ${res.status} (want ${want})`);
}

export function filePath(fileId: string): string {
  return `/files/${encodeURIComponent(fileId)}`;
}

/** Query string for GET /files (empty string when unfiltered). */
export function listQuery(filter: ListFilter): string {
  const q = new URLSearchParams();
  if (filter.contentType) q.set("content_type", filter.contentType);
  for (const [key, value] of Object.entries(filter.tags ?? {})) q.set(`tag.${key}`, value);
  if (filter.limit) q.set("limit", String(filter.limit));
  if (filter.cursor) q.set("cursor", filter.cursor);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** A bytes= header for offset/length (length undefined means "to the end"). */
export function rangeHeader(offset: number, length?: number): string {
  if (length && length > 0) return `bytes=${offset}-${offset + length - 1}`;
  return `bytes=${offset}-`;
}

/** Combine optional signals into one (AbortSignal.any needs Node 20.3). */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length <= 1) return real[0];
  const controller = new AbortController();
  for (const signal of real) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
