import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AnafClient } from '../anaf/anaf.client';
import { mapAnafRecord } from '../anaf/anaf.mapper';
import { AnafAttempt } from '../anaf/anaf.types';
import { Company } from '../companies/company.entity';
import { InvalidCuiError, normalizeCui } from '../cui/cui.util';
import { DataSnapshot, SnapshotSource } from './data-snapshot.entity';
import { VerificationCase, VerificationStatus } from './verification-case.entity';

/** Shown to the operator, wording taken from the specification (section 4.1). */
export const NOT_FOUND_MESSAGE =
  'Компания с таким CUI в базе ANAF не найдена, проверьте номер';

export interface VerificationResult {
  verification: VerificationCase;
  company: Company | null;
  message: string | null;
}

@Injectable()
export class VerificationsService {
  private readonly logger = new Logger(VerificationsService.name);

  constructor(
    private readonly cases: Repository<VerificationCase>,
    private readonly snapshots: Repository<DataSnapshot>,
    private readonly companies: Repository<Company>,
    private readonly anaf: AnafClient,
  ) {}

  async create(rawCui: string): Promise<VerificationResult> {
    // Malformed input never reaches the external service: there is nothing to check and
    // no reason to spend a request from a rate-limited budget.
    let normalized;
    try {
      normalized = normalizeCui(rawCui);
    } catch (error) {
      if (error instanceof InvalidCuiError) throw new BadRequestException(error.message);
      throw error;
    }

    // PENDING, never a terminal status: if the process dies mid-lookup the permanent
    // record must say "unfinished", not claim an outage that did not happen.
    const verification = await this.cases.save(
      this.cases.create({
        requestedCui: normalized.value,
        status: VerificationStatus.PENDING,
        startedAt: new Date(),
        finishedAt: null,
        companyId: null,
        note: null,
      }),
    );

    const persistAttempt = async (attempt: AnafAttempt): Promise<void> => {
      await this.snapshots.save(
        this.snapshots.create({
          verificationCaseId: verification.id,
          source: SnapshotSource.ANAF,
          requestedAt: attempt.requestedAt,
          request: attempt.request,
          response: attempt.response,
          success: attempt.success,
          httpStatus: attempt.httpStatus,
          errorMessage: attempt.errorMessage,
          durationMs: attempt.durationMs,
          queueWaitMs: attempt.queueWaitMs,
          attempt: attempt.attempt,
        }),
      );
    };

    const outcome = await this.anaf.lookup(normalized.value, persistAttempt);

    let company: Company | null = null;
    let message: string | null = null;

    switch (outcome.kind) {
      case 'found': {
        company = await this.upsertCompany(mapAnafRecord(outcome.record, normalized.value));
        verification.companyId = company.id;
        verification.status = VerificationStatus.COMPLETED;
        break;
      }
      case 'notFound': {
        verification.status = VerificationStatus.NOT_FOUND;
        message = NOT_FOUND_MESSAGE;
        break;
      }
      case 'unavailable': {
        verification.status = VerificationStatus.SOURCE_UNAVAILABLE;
        message = outcome.reason;
        break;
      }
      case 'invalidResponse': {
        verification.status = VerificationStatus.INVALID_RESPONSE;
        message = outcome.reason;
        break;
      }
    }

    // The checksum is advisory, never a blocker — it is recorded, not enforced.
    if (!normalized.checksumValid) {
      const warning = 'CUI control digit does not match (advisory only, the lookup was performed)';
      message = message ? `${message}. ${warning}` : warning;
    }

    verification.note = message;
    verification.finishedAt = new Date();
    const saved = await this.cases.save(verification);

    return { verification: saved, company, message };
  }

  private async upsertCompany(mapped: ReturnType<typeof mapAnafRecord>): Promise<Company> {
    const existing = await this.companies.findOne({ where: { cui: mapped.cui } });
    const now = new Date();

    if (existing) {
      Object.assign(existing, {
        name: mapped.name,
        registrationNumber: mapped.registrationNumber,
        address: mapped.address,
        caenCode: mapped.caenCode,
        isInactive: mapped.isInactive,
        vatPayer: mapped.vatPayer,
        registeredAt: mapped.registeredAt,
        lastCheckedAt: now,
      });
      return this.companies.save(existing);
    }

    return this.companies.save(
      this.companies.create({ ...mapped, country: 'RO', lastCheckedAt: now }),
    );
  }

  async findOne(id: string): Promise<{
    verification: VerificationCase;
    company: Company | null;
    snapshots: Array<Pick<DataSnapshot, 'id' | 'source' | 'requestedAt' | 'success' | 'httpStatus' | 'durationMs' | 'queueWaitMs' | 'attempt'>>;
  } | null> {
    const verification = await this.cases.findOne({ where: { id } });
    if (!verification) return null;

    const company = verification.companyId
      ? await this.companies.findOne({ where: { id: verification.companyId } })
      : null;

    const snapshots = await this.snapshots.find({
      where: { verificationCaseId: id },
      order: { requestedAt: 'ASC' },
    });

    return {
      verification,
      company: company ?? null,
      // Metadata only. Raw external payloads stay in the database; they are evidence,
      // not something to hand out over the API by default.
      snapshots: snapshots.map((s) => ({
        id: s.id,
        source: s.source,
        requestedAt: s.requestedAt,
        success: s.success,
        httpStatus: s.httpStatus,
        durationMs: s.durationMs,
        queueWaitMs: s.queueWaitMs,
        attempt: s.attempt,
      })),
    };
  }
}
