/** Extraction jobs: the model, its parser, and the errors of the blocking wait. */

import { CairnMarkError } from "./errors.js";
import { parseExtractSummary, type ExtractSummary } from "./types.js";

/**
 * The states an extraction job can be in. A job goes back from "running" to
 * "pending" when its worker shuts down or stops reporting, so leaving
 * "running" is not the end — only the three terminal states are.
 */
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/** Whether a job in this state will not change state again. */
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Where a run is: `done` entries processed of the `total` it intends to write
 * — not the archive's entry count. A job resumed after an interruption counts
 * only what remained.
 */
export interface JobProgress {
  done: number;
  total: number;
}

/**
 * One extraction job, as the server reports it. A job id is a bearer
 * capability like a file id: whoever holds it can poll and cancel the job.
 */
export interface Job {
  id: string;
  archiveId: string;
  status: JobStatus;
  progress: JobProgress;
  cancelRequested: boolean;
  /**
   * The result once the job is terminal — the same shape `extract` resolves
   * to. Undefined before then, and on a job that never ran (cancelled while
   * pending, or failed before the archive could be opened).
   */
  summary?: ExtractSummary;
  /** The reason when `status` is "failed". */
  error?: string;
  /** RFC 3339 timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Null until terminal. */
  finishedAt: string | null;
}

export function parseJob(data: any): Job {
  return {
    id: data.id,
    archiveId: data.archive_id,
    status: data.status,
    progress: { done: data.progress?.done ?? 0, total: data.progress?.total ?? 0 },
    cancelRequested: !!data.cancel_requested,
    summary: data.summary ? parseExtractSummary(data.summary) : undefined,
    error: data.error || undefined,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    finishedAt: data.finished_at ?? null,
  };
}

/**
 * An extraction job ended other than by succeeding; `job` is its terminal
 * state. Rejected by `extract`; never by `waitForJob`, which resolves to the
 * job whatever its outcome.
 */
export class JobError extends CairnMarkError {
  constructor(
    readonly job: Job,
    message: string,
  ) {
    super(message);
  }
}

/** The job failed; `job.error` says why. */
export class ExtractionFailedError extends JobError {
  constructor(job: Job) {
    super(job, `cairnmark: extraction job ${job.id} failed: ${job.error ?? "unknown reason"}`);
  }
}

/**
 * The job was cancelled; `job.summary` is the partial result, and the entries
 * stored before the cancel remain — a later `extract` resumes past them.
 * Distinct from ExtractionFailedError so "I cancelled this" and "it broke"
 * are told apart.
 */
export class ExtractionCancelledError extends JobError {
  constructor(job: Job) {
    super(
      job,
      `cairnmark: extraction job ${job.id} cancelled after ${job.progress.done} of ${job.progress.total} entries`,
    );
  }
}

/** The error for a terminal job that did not succeed. */
export function jobError(job: Job): JobError {
  return job.status === "cancelled"
    ? new ExtractionCancelledError(job)
    : new ExtractionFailedError(job);
}

/** The default first wait between polls, and the ceiling the doubling stops at. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const MAX_POLL_INTERVAL_MS = 10_000;

/** The wait after `delay`: doubled, up to the ceiling (or `initial` if larger). */
export function nextPollDelayMs(delay: number, initial: number): number {
  return Math.min(delay * 2, Math.max(MAX_POLL_INTERVAL_MS, initial));
}

export function jobPath(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`;
}
