import { VerificationCase, VerificationStatus } from './verification-case.entity';
import { INTERRUPTED_NOTE, StaleVerificationReaper } from './stale-verification.reaper';
import { fakeRepository } from '../../test/fake-repository';

describe('StaleVerificationReaper', () => {
  const NOW = new Date('2026-09-17T12:00:00Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  let cases: ReturnType<typeof fakeRepository<VerificationCase>>;
  let reaper: StaleVerificationReaper;

  const seed = (status: VerificationStatus, startedAt: Date): VerificationCase => {
    const c = cases.create({
      requestedCui: 14399840,
      companyId: null,
      status,
      startedAt,
      finishedAt: status === VerificationStatus.PENDING ? null : startedAt,
      note: null,
    });
    cases.rows.push(Object.assign(c, { id: `id-${cases.rows.length + 1}` }));
    return c;
  };

  beforeEach(() => {
    cases = fakeRepository<VerificationCase>();
    reaper = new StaleVerificationReaper(cases, { pendingTimeoutMs: 5 * 60_000, intervalMs: 60_000 });
  });

  it('marks only PENDING cases older than the timeout as INTERRUPTED', async () => {
    const stale = seed(VerificationStatus.PENDING, minutesAgo(6));
    const fresh = seed(VerificationStatus.PENDING, minutesAgo(1));
    const done = seed(VerificationStatus.COMPLETED, minutesAgo(60));
    const failed = seed(VerificationStatus.SOURCE_UNAVAILABLE, minutesAgo(60));

    const count = await reaper.sweep(NOW);

    expect(count).toBe(1);
    expect(stale.status).toBe(VerificationStatus.INTERRUPTED);
    expect(stale.finishedAt).toEqual(NOW);
    expect(stale.note).toBe(INTERRUPTED_NOTE);
    // An in-flight check is left alone: it may still finish.
    expect(fresh.status).toBe(VerificationStatus.PENDING);
    expect(fresh.finishedAt).toBeNull();
    // Terminal rows are never touched, however old.
    expect(done.status).toBe(VerificationStatus.COMPLETED);
    expect(failed.status).toBe(VerificationStatus.SOURCE_UNAVAILABLE);
  });

  it('is idempotent: a second sweep finds nothing to do', async () => {
    seed(VerificationStatus.PENDING, minutesAgo(10));
    expect(await reaper.sweep(NOW)).toBe(1);
    expect(await reaper.sweep(NOW)).toBe(0);
    expect(cases.rows.filter((c) => c.status === VerificationStatus.INTERRUPTED)).toHaveLength(1);
  });

  it('treats exactly-at-threshold as not yet stale', async () => {
    const atThreshold = seed(VerificationStatus.PENDING, minutesAgo(5));
    expect(await reaper.sweep(NOW)).toBe(0);
    expect(atThreshold.status).toBe(VerificationStatus.PENDING);
  });

  it('survives a failing query and reports nothing swept', async () => {
    cases.find = jest.fn().mockRejectedValue(new Error('connection refused')) as never;
    await expect(reaper.sweep(NOW)).resolves.toBe(0);
  });

  it('runs a sweep on init and stops its timer on destroy', async () => {
    const spy = jest.spyOn(reaper, 'sweep').mockResolvedValue(0);
    reaper.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    reaper.onModuleDestroy();
    // A cleared, unref'd timer must not fire again or hold the process.
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
