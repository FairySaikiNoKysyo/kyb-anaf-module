import { Logger } from '@nestjs/common';
// Imported from undici rather than using the global `fetch` so that the HTTP layer can
// be intercepted deterministically in tests. Node's built-in fetch carries its own
// internal undici instance, which `setGlobalDispatcher` from this package cannot reach —
// a suite written against the global would quietly make real calls to ANAF.
import { fetch } from 'undici';
import { AnafRateLimiter } from '../common/rate-limit/anaf-rate-limiter';
import { anafResponseSchema } from './anaf.schema';
import { AnafAttempt, AnafOutcome, AttemptSink } from './anaf.types';

export interface AnafClientOptions {
  baseUrl: string;
  apiVersion: string;
  timeoutMs: number;
  userAgent: string;
  maxRetries: number;
  /** Backoff before attempt N+1. Overridable so tests do not wait seconds. */
  backoffMs?: (attempt: number) => number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRYABLE_STATUS = (s: number) => s >= 500 || s === 429;

export class AnafClient {
  private readonly logger = new Logger(AnafClient.name);

  constructor(
    private readonly options: AnafClientOptions,
    private readonly rateLimiter: AnafRateLimiter,
  ) {}

  private get url(): string {
    return `${this.options.baseUrl}/${this.options.apiVersion}/tva`;
  }

  private backoff(attempt: number): number {
    return this.options.backoffMs ? this.options.backoffMs(attempt) : 1000 * 2 ** (attempt - 1);
  }

  /**
   * Looks up one CUI.
   *
   * Every attempt — including every failed one — is reported to `onAttempt` before this
   * method returns. The specification (section 10) requires failed calls to be stored
   * too: they are the evidence that the check was attempted, which is the whole point of
   * the audit trail.
   */
  async lookup(cui: number, onAttempt: AttemptSink, asOf: Date = new Date()): Promise<AnafOutcome> {
    const body = [{ cui, data: asOf.toISOString().slice(0, 10) }];
    const request = { method: 'POST', url: this.url, body };
    let lastReason = 'ANAF did not return a usable response';

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 1) await sleep(this.backoff(attempt - 1));

      const requestedAt = new Date();
      const startedAt = Date.now();

      const result = await this.rateLimiter.schedule(() => this.attempt(body));
      const durationMs = Date.now() - startedAt;

      const record: AnafAttempt = {
        attempt,
        requestedAt,
        request,
        response: result.rawBody ?? null,
        success: result.ok,
        httpStatus: result.status,
        errorMessage: result.ok ? null : result.reason,
        durationMs,
      };
      await onAttempt(record);

      this.logger.log(
        JSON.stringify({
          source: 'ANAF',
          cui,
          attempt,
          httpStatus: result.status,
          durationMs,
          outcome: result.ok ? 'http_ok' : 'http_failed',
        }),
      );

      if (!result.ok) {
        lastReason = result.reason;
        if (result.retryable && attempt < this.options.maxRetries) continue;
        return { kind: 'unavailable', reason: lastReason };
      }

      // HTTP succeeded. Now the body has to make sense.
      const parsed = anafResponseSchema.safeParse(result.rawBody);
      if (!parsed.success) {
        // NOT retried: a valid HTTP response with an unexpected shape means the contract
        // changed. Hammering the service will not fix that, and a human must look.
        return {
          kind: 'invalidResponse',
          reason: `Unexpected ANAF response shape: ${parsed.error.issues.map((i) => i.path.join('.') || 'root').join(', ')}`,
        };
      }

      const found = parsed.data.found ?? [];
      if (found.length > 0) return { kind: 'found', record: found[0] };
      return { kind: 'notFound' };
    }

    return { kind: 'unavailable', reason: lastReason };
  }

  private async attempt(
    body: unknown,
  ): Promise<
    | { ok: true; status: number; rawBody: unknown }
    | { ok: false; status: number | null; rawBody: unknown | null; reason: string; retryable: boolean }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ANAF rejects requests with an empty or suspicious User-Agent
          // (specification, section 4.1). This is not optional politeness.
          'User-Agent': this.options.userAgent,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let rawBody: unknown = text;
      try {
        rawBody = text.length ? JSON.parse(text) : null;
      } catch {
        // Keep the raw text: an unparseable body is still audit evidence.
      }

      // Verified against the live v9 service: an unknown CUI comes back as HTTP 404 with
      // the normal envelope, `{"found":[],"notFound":[<cui>]}`. That is a successful
      // lookup whose answer is "not found", not a failure. A 404 WITHOUT that envelope
      // (e.g. a wrong endpoint path, which returns problem+json) is still a failure —
      // otherwise a misconfigured URL would report every company as not found.
      const isNotFoundEnvelope =
        response.status === 404 &&
        typeof rawBody === 'object' &&
        rawBody !== null &&
        Array.isArray((rawBody as Record<string, unknown>).notFound);

      if (!response.ok && !isNotFoundEnvelope) {
        return {
          ok: false,
          status: response.status,
          rawBody,
          reason: `ANAF returned HTTP ${response.status}`,
          retryable: RETRYABLE_STATUS(response.status),
        };
      }
      return { ok: true, status: response.status, rawBody };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        status: null,
        rawBody: null,
        reason: aborted
          ? `ANAF request timed out after ${this.options.timeoutMs}ms`
          : `ANAF request failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
