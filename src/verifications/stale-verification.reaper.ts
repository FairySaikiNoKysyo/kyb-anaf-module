import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LessThan, Repository } from 'typeorm';
import { DataSnapshot } from './data-snapshot.entity';
import { VerificationCase, VerificationStatus } from './verification-case.entity';
import { VerificationsService } from './verifications.service';

export const INTERRUPTED_NOTE = 'Interrupted: the process did not finish this check. Run a new verification.';

export interface ReaperOptions {
  /** A PENDING case older than this is considered abandoned. */
  pendingTimeoutMs: number;
  /** How often to look. */
  intervalMs: number;
}

export interface SweepResult {
  /** Cases finished from a stored successful snapshot, without a new ANAF call. */
  recovered: number;
  /** Cases with no usable snapshot, marked INTERRUPTED. */
  interrupted: number;
}

/**
 * Closes verifications that will never finish on their own.
 *
 * A case is inserted as PENDING before the external lookup starts (the snapshots need
 * something to point at), and the snapshot is written before the case is finalised. If
 * the process dies in between, the row stays PENDING forever — often right next to a
 * successful snapshot that already holds ANAF's answer.
 *
 * So the sweep does two different things, in this order of preference:
 *   1. a PENDING case with a successful snapshot is FINISHED from that snapshot — same
 *      rules as the live path, no new request to ANAF, nothing lost;
 *   2. a PENDING case with no successful snapshot (died before the answer, or every
 *      attempt failed) is marked INTERRUPTED so the journal says what actually happened.
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
    private readonly snapshots: Repository<DataSnapshot>,
    private readonly verifications: VerificationsService,
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

  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = { recovered: 0, interrupted: 0 };
    const cutoff = new Date(now.getTime() - this.options.pendingTimeoutMs);
    let stale: VerificationCase[];
    try {
      stale = await this.cases.find({
        where: { status: VerificationStatus.PENDING, startedAt: LessThan(cutoff) },
      });
    } catch (error) {
      // Housekeeping must never take the service down; the next tick will try again.
      this.logger.warn(`Reaper query failed: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }

    for (const c of stale) {
      try {
        const usable = await this.latestSuccessfulSnapshot(c.id);
        if (usable) {
          const { verification } = await this.verifications.completeFromSnapshot(c, usable);
          result.recovered++;
          this.logger.warn(
            JSON.stringify({ event: 'stale_verification_recovered', id: c.id, status: verification.status, fromSnapshot: usable.id }),
          );
        } else {
          c.status = VerificationStatus.INTERRUPTED;
          c.finishedAt = now;
          c.note = INTERRUPTED_NOTE;
          await this.cases.save(c);
          result.interrupted++;
        }
      } catch (error) {
        this.logger.warn(
          `Could not close verification ${c.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (result.recovered + result.interrupted > 0) {
      this.logger.warn(JSON.stringify({ event: 'stale_verifications_swept', ...result, olderThanMs: this.options.pendingTimeoutMs }));
    }
    return result;
  }

  /** The newest snapshot whose HTTP call succeeded and whose body was kept. */
  private async latestSuccessfulSnapshot(verificationCaseId: string): Promise<DataSnapshot | null> {
    const all = await this.snapshots.find({ where: { verificationCaseId } });
    return (
      all
        .filter((s) => s.success && s.response !== null && s.response !== undefined)
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0] ?? null
    );
  }
}
