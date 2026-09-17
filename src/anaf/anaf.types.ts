import { AnafFoundEntry } from './anaf.schema';

/**
 * Every expected outcome is a RETURN VALUE, not an exception.
 *
 * "Company not found" in particular is a valid business result: in a KYB check,
 * "this company does not exist in the tax register" is an answer the operator needs,
 * not an error to swallow. Exceptions are reserved for programmer errors.
 */
export type AnafOutcome =
  | { kind: 'found'; record: AnafFoundEntry }
  | { kind: 'notFound' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'invalidResponse'; reason: string };

/** One HTTP attempt, successful or not. Persisted as a DataSnapshot by the caller. */
export interface AnafAttempt {
  attempt: number;
  requestedAt: Date;
  request: Record<string, unknown>;
  response: unknown | null;
  /** Whether the HTTP call itself succeeded. A notFound response is a SUCCESS. */
  success: boolean;
  httpStatus: number | null;
  errorMessage: string | null;
  durationMs: number;
}

export type AttemptSink = (attempt: AnafAttempt) => void | Promise<void>;
