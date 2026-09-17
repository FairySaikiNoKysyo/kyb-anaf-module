import { AnafClient } from '../anaf/anaf.client';
import { Company } from '../companies/company.entity';
import { DataSnapshot, SnapshotSource } from './data-snapshot.entity';
import { VerificationCase, VerificationStatus } from './verification-case.entity';
import { INTERRUPTED_NOTE, StaleVerificationReaper } from './stale-verification.reaper';
import { NOT_FOUND_MESSAGE, RECOVERED_NOTE, VerificationsService } from './verifications.service';
import { fakeRepository } from '../../test/fake-repository';

import found from '../../test/fixtures/anaf-found.json';
import notFound from '../../test/fixtures/anaf-not-found.json';

describe('StaleVerificationReaper', () => {
  const NOW = new Date('2026-09-17T12:00:00Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  let cases: ReturnType<typeof fakeRepository<VerificationCase>>;
  let snapshots: ReturnType<typeof fakeRepository<DataSnapshot>>;
  let companies: ReturnType<typeof fakeRepository<Company>>;
  let reaper: StaleVerificationReaper;
  let anaf: { lookup: jest.Mock };

  const seedCase = (status: VerificationStatus, startedAt: Date, cui = 14399840): VerificationCase => {
    const c = cases.create({
      requestedCui: cui,
      companyId: null,
      status,
      startedAt,
      finishedAt: status === VerificationStatus.PENDING ? null : startedAt,
      note: null,
    });
    cases.rows.push(Object.assign(c, { id: `case-${cases.rows.length + 1}` }));
    return c;
  };

  const seedSnapshot = (
    verificationCaseId: string,
    partial: Partial<DataSnapshot> & Pick<DataSnapshot, 'success' | 'response' | 'httpStatus'>,
  ): DataSnapshot => {
    const s = snapshots.create({
      verificationCaseId,
      source: SnapshotSource.ANAF,
      requestedAt: partial.requestedAt ?? minutesAgo(9),
      request: { method: 'POST', url: 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva', body: [] },
      errorMessage: null,
      durationMs: 100,
      queueWaitMs: 0,
      attempt: partial.attempt ?? 1,
      ...partial,
    });
    snapshots.rows.push(Object.assign(s, { id: `snap-${snapshots.rows.length + 1}` }));
    return s;
  };

  beforeEach(() => {
    cases = fakeRepository<VerificationCase>();
    snapshots = fakeRepository<DataSnapshot>();
    companies = fakeRepository<Company>();
    // The recovery path must never call ANAF. A lookup here fails the test.
    anaf = { lookup: jest.fn().mockRejectedValue(new Error('ANAF must not be called during recovery')) };
    const service = new VerificationsService(cases, snapshots, companies, anaf as unknown as AnafClient);
    reaper = new StaleVerificationReaper(cases, snapshots, service, { pendingTimeoutMs: 5 * 60_000, intervalMs: 60_000 });
  });

  it('finishes a stale PENDING case from its successful snapshot without calling ANAF', async () => {
    // The exact situation: ANAF answered, the snapshot was written, the process died
    // before the case was updated.
    const stuck = seedCase(VerificationStatus.PENDING, minutesAgo(10));
    const snap = seedSnapshot(stuck.id, { success: true, httpStatus: 200, response: found });

    const result = await reaper.sweep(NOW);

    expect(result).toEqual({ recovered: 1, interrupted: 0 });
    expect(anaf.lookup).not.toHaveBeenCalled();
    expect(stuck.status).toBe(VerificationStatus.COMPLETED);
    expect(stuck.finishedAt).toBeInstanceOf(Date);
    expect(stuck.note).toContain(RECOVERED_NOTE);
    // The company row is derived from the snapshot, exactly as the live path would.
    expect(companies.rows).toHaveLength(1);
    expect(companies.rows[0].cui).toBe(14399840);
    expect(companies.rows[0].name).toBe('DANTE INTERNATIONAL SA');
    expect(stuck.companyId).toBe(companies.rows[0].id);
    // The snapshot itself is untouched: append-only.
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0]).toBe(snap);
  });

  it('recovers a NOT_FOUND outcome from a stored 404 envelope', async () => {
    const stuck = seedCase(VerificationStatus.PENDING, minutesAgo(10), 99999999);
    seedSnapshot(stuck.id, { success: true, httpStatus: 404, response: notFound });

    const result = await reaper.sweep(NOW);

    expect(result).toEqual({ recovered: 1, interrupted: 0 });
    expect(stuck.status).toBe(VerificationStatus.NOT_FOUND);
    expect(stuck.note).toContain(NOT_FOUND_MESSAGE);
    expect(stuck.note).toContain(RECOVERED_NOTE);
    expect(companies.rows).toHaveLength(0);
  });

  it('uses the newest successful snapshot when there are several attempts', async () => {
    const stuck = seedCase(VerificationStatus.PENDING, minutesAgo(10));
    seedSnapshot(stuck.id, { success: false, httpStatus: 500, response: 'boom', attempt: 1, requestedAt: minutesAgo(9) });
    seedSnapshot(stuck.id, { success: true, httpStatus: 200, response: found, attempt: 2, requestedAt: minutesAgo(8) });

    const result = await reaper.sweep(NOW);

    expect(result).toEqual({ recovered: 1, interrupted: 0 });
    expect(stuck.status).toBe(VerificationStatus.COMPLETED);
  });

  it('marks a stale PENDING case INTERRUPTED when no snapshot succeeded', async () => {
    const noSnapshot = seedCase(VerificationStatus.PENDING, minutesAgo(10));
    const onlyFailures = seedCase(VerificationStatus.PENDING, minutesAgo(10));
    seedSnapshot(onlyFailures.id, { success: false, httpStatus: 500, response: 'upstream exploded' });
    seedSnapshot(onlyFailures.id, { success: false, httpStatus: null, response: null, attempt: 2 });

    const result = await reaper.sweep(NOW);

    expect(result).toEqual({ recovered: 0, interrupted: 2 });
    for (const c of [noSnapshot, onlyFailures]) {
      expect(c.status).toBe(VerificationStatus.INTERRUPTED);
      expect(c.finishedAt).toEqual(NOW);
      expect(c.note).toBe(INTERRUPTED_NOTE);
    }
    expect(anaf.lookup).not.toHaveBeenCalled();
  });

  it('leaves fresh PENDING cases and terminal cases alone', async () => {
    const fresh = seedCase(VerificationStatus.PENDING, minutesAgo(1));
    seedSnapshot(fresh.id, { success: true, httpStatus: 200, response: found });
    const done = seedCase(VerificationStatus.COMPLETED, minutesAgo(60));
    const failed = seedCase(VerificationStatus.SOURCE_UNAVAILABLE, minutesAgo(60));

    const result = await reaper.sweep(NOW);

    expect(result).toEqual({ recovered: 0, interrupted: 0 });
    // Even with a usable snapshot: it may still finish on its own.
    expect(fresh.status).toBe(VerificationStatus.PENDING);
    expect(done.status).toBe(VerificationStatus.COMPLETED);
    expect(failed.status).toBe(VerificationStatus.SOURCE_UNAVAILABLE);
  });

  it('is idempotent: a second sweep finds nothing to do', async () => {
    const stuck = seedCase(VerificationStatus.PENDING, minutesAgo(10));
    seedSnapshot(stuck.id, { success: true, httpStatus: 200, response: found });
    expect(await reaper.sweep(NOW)).toEqual({ recovered: 1, interrupted: 0 });
    expect(await reaper.sweep(NOW)).toEqual({ recovered: 0, interrupted: 0 });
    expect(companies.rows).toHaveLength(1);
  });

  it('treats exactly-at-threshold as not yet stale', async () => {
    const atThreshold = seedCase(VerificationStatus.PENDING, minutesAgo(5));
    expect(await reaper.sweep(NOW)).toEqual({ recovered: 0, interrupted: 0 });
    expect(atThreshold.status).toBe(VerificationStatus.PENDING);
  });

  it('survives a failing query and reports nothing swept', async () => {
    cases.find = jest.fn().mockRejectedValue(new Error('connection refused')) as never;
    await expect(reaper.sweep(NOW)).resolves.toEqual({ recovered: 0, interrupted: 0 });
  });

  it('runs a sweep on init and stops its timer on destroy', async () => {
    const spy = jest.spyOn(reaper, 'sweep').mockResolvedValue({ recovered: 0, interrupted: 0 });
    reaper.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    reaper.onModuleDestroy();
    // A cleared, unref'd timer must not fire again or hold the process.
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
