import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LessThan, Repository } from 'typeorm';
import { VerificationCase, VerificationStatus } from './verification-case.entity';

export const INTERRUPTED_NOTE = 'Interrupted: the process did not finish this check. Run a new verification.';

export interface ReaperOptions {
  /** A PENDING case older than this is considered abandoned. */
  pendingTimeoutMs: number;
  /** How often to look. */
  intervalMs: number;
}

/**
 * Closes verifications that will never finish on their own.
 *
 * A case is inserted as PENDING before the external lookup starts (the snapshots need
 * something to point at). If the process dies in between, nothing ever writes the
 * outcome and the row stays PENDING forever. This job marks such rows INTERRUPTED so
 * the journal says what actually happened: the check was started and not completed.
 *
 * It is a plain setInterval, not a scheduler library: one query a minute needs no
 * infrastructure. The timer is unref'd so it never keeps the process alive, and it is
 * cleared on shutdown.
 */
export class StaleVerificationReaper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleVerificationReaper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cases: Repository<VerificationCase>,
    private readonly options: ReaperOptions,
  ) {}

  onModuleInit(): void {
    // Run once at startup: the rows most likely to be stuck are the ones left behind
    // by the previous life of this process.
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Marks every PENDING case older than the threshold as INTERRUPTED. Returns how many. */
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.options.pendingTimeoutMs);
    let stale: VerificationCase[];
    try {
      stale = await this.cases.find({
        where: { status: VerificationStatus.PENDING, startedAt: LessThan(cutoff) },
      });
    } catch (error) {
      // Housekeeping must never take the service down; the next tick will try again.
      this.logger.warn(`Reaper query failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }

    let count = 0;
    for (const c of stale) {
      c.status = VerificationStatus.INTERRUPTED;
      c.finishedAt = now;
      c.note = INTERRUPTED_NOTE;
      try {
        await this.cases.save(c);
        count++;
      } catch (error) {
        this.logger.warn(
          `Could not mark verification ${c.id} as interrupted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (count > 0) {
      this.logger.warn(
        JSON.stringify({ event: 'stale_verifications_interrupted', count, olderThanMs: this.options.pendingTimeoutMs }),
      );
    }
    return count;
  }
}
