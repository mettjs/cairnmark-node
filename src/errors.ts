/** Typed errors for the CairnMark API's client-facing failure modes. */

export class CairnMarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A verified download's bytes did not hash to the stored SHA-256. Errors the
 * stream as its last chunk is consumed — never sent by the server.
 */
export class ChecksumMismatchError extends CairnMarkError {
  constructor(
    readonly got: string,
    readonly expected: string,
  ) {
    super(`cairnmark: downloaded sha256 ${got}, stored ${expected}`);
  }
}

/** A non-2xx response from the server. */
export class APIError extends CairnMarkError {
  constructor(
    /** HTTP status code. */
    readonly status: number,
    /** The server's error message. */
    readonly serverMessage: string,
    /** Milliseconds the server asked to wait (409 conflicts); else undefined. */
    readonly retryAfterMs?: number,
    /** On a 409 extraction conflict: the id of the job holding the archive. */
    readonly jobId?: string,
  ) {
    super(`cairnmark: server returned ${status}: ${serverMessage}`);
  }
}

/** 400: malformed request — bad id, bad parameters, bad metadata JSON. */
export class InvalidRequestError extends APIError {}

/**
 * 404: the file id does not exist (or was soft-deleted), or the job id does
 * not exist (or was purged past the server's retention).
 */
export class NotFoundError extends APIError {}

/**
 * 409: an upload with the same Idempotency-Key is still in flight
 * (`retryAfterMs` says when to ask again), or another extraction job for the
 * same archive is pending or running (`jobId` names it — the one to poll).
 */
export class IdempotencyConflictError extends APIError {}

/**
 * 410: the file created under this Idempotency-Key was deleted. Retrying the
 * same key can never succeed — switch to a new key.
 */
export class IdempotencyGoneError extends APIError {}

/**
 * 413: the body exceeds a server cap (upload size or metadata patch), or an
 * archive exceeds the extraction caps.
 */
export class TooLargeError extends APIError {}

/** 415: an archive endpoint was pointed at a file that is not a zip. */
export class NotArchiveError extends APIError {}

/** 416: the requested byte range lies outside the file. */
export class RangeNotSatisfiableError extends APIError {}

/** 5xx: the server failed; the message is generic by design. */
export class ServerError extends APIError {}

const BY_STATUS: Record<number, typeof APIError> = {
  400: InvalidRequestError,
  404: NotFoundError,
  409: IdempotencyConflictError,
  410: IdempotencyGoneError,
  413: TooLargeError,
  415: NotArchiveError,
  416: RangeNotSatisfiableError,
};

/** The APIError subclass for an HTTP status. */
export function errorClassFor(status: number): typeof APIError {
  return BY_STATUS[status] ?? (status >= 500 ? ServerError : APIError);
}
