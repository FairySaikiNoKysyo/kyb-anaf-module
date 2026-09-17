import { BadRequestException } from '@nestjs/common';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';
import { AnafClient } from '../anaf/anaf.client';
import { AnafRateLimiter } from '../common/rate-limit/anaf-rate-limiter';
import { Company } from '../companies/company.entity';
import { DataSnapshot } from './data-snapshot.entity';
import { VerificationCase, VerificationStatus } from './verification-case.entity';
import { NOT_FOUND_MESSAGE, VerificationsService } from './verifications.service';
import { fakeRepository } from '../../test/fake-repository';

import found from '../../test/fixtures/anaf-found.json';
import foundInactive from '../../test/fixtures/anaf-found-inactive.json';
import notFound from '../../test/fixtures/anaf-not-found.json';
import malformed from '../../test/fixtures/anaf-malformed.json';

/**
 * The HTTP layer is mocked with undici's MockAgent rather than nock.
 *
 * nock patches Node's http/https modules, which global `fetch` (undici) does not go
 * through — a nock-based suite here would silently let real requests out. MockAgent is
 * the supported way to intercept fetch, and `enableNetConnect` is never called, so any
 * request the tests did not declare fails the run instead of hitting ANAF.
 */
const ORIGIN = 'https://webservicesp.anaf.ro';
const PATH = '/api/PlatitorTvaRest/v9/tva';

describe('VerificationsService', () => {
  let agent: MockAgent;
  let original: Dispatcher;
  let cases: ReturnType<typeof fakeRepository<VerificationCase>>;
  let snapshots: ReturnType<typeof fakeRepository<DataSnapshot>>;
  let companies: ReturnType<typeof fakeRepository<Company>>;
  let service: VerificationsService;

  const build = (maxRetries = 3): VerificationsService => {
    const client = new AnafClient(
      {
        baseUrl: `${ORIGIN}/api/PlatitorTvaRest`,
        apiVersion: 'v9',
        timeoutMs: 300,
        userAgent: 'KYB-Module/1.0-test',
        maxRetries,
        backoffMs: () => 1, // the backoff policy is asserted separately; no need to wait here
      },
      new AnafRateLimiter(0),
    );
    return new VerificationsService(cases, snapshots, companies, client);
  };

  beforeEach(() => {
    original = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);

    cases = fakeRepository<VerificationCase>();
    snapshots = fakeRepository<DataSnapshot>();
    companies = fakeRepository<Company>();
    service = build();
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(original);
  });

  const pool = () => agent.get(ORIGIN);

  it('1. stores the company and completes the case when ANAF finds it', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, found);

    const result = await service.create('RO 14399840');

    expect(result.verification.status).toBe(VerificationStatus.COMPLETED);
    expect(result.company?.name).toBe('TEST COMPANY SRL');
    expect(result.company?.registrationNumber).toBe('J40/1234/2015');
    expect(result.company?.caenCode).toBe('6201');
    expect(companies.rows).toHaveLength(1);
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0].success).toBe(true);
    expect(result.verification.companyId).toBe(result.company?.id);
  });

  it('2. treats "not found" as a business result, not an error', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, notFound);

    const result = await service.create('99999999');

    expect(result.verification.status).toBe(VerificationStatus.NOT_FOUND);
    expect(result.company).toBeNull();
    expect(companies.rows).toHaveLength(0);
    expect(result.message).toContain(NOT_FOUND_MESSAGE);
    // The HTTP call itself succeeded, so the snapshot is a success.
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0].success).toBe(true);
    // The verification still exists — that record is the point of the module.
    expect(result.verification.id).toBeDefined();
    expect(result.verification.finishedAt).toBeInstanceOf(Date);
  });

  it('3. retries a 5xx three times and stores a failed snapshot for every attempt', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(500, 'upstream exploded').times(3);

    const result = await service.create('14399840');

    expect(result.verification.status).toBe(VerificationStatus.SOURCE_UNAVAILABLE);
    expect(snapshots.rows).toHaveLength(3);
    expect(snapshots.rows.every((s) => s.success === false)).toBe(true);
    expect(snapshots.rows.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(snapshots.rows[0].httpStatus).toBe(500);
    // Even a failed attempt keeps what came back: it is the evidence of the attempt.
    expect(snapshots.rows[0].response).toBe('upstream exploded');
  });

  it('4. reports the source as unavailable when the request times out', async () => {
    pool()
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, found)
      .delay(1000)
      .times(3);

    const result = await service.create('14399840');

    expect(result.verification.status).toBe(VerificationStatus.SOURCE_UNAVAILABLE);
    expect(snapshots.rows.length).toBeGreaterThanOrEqual(1);
    expect(snapshots.rows.every((s) => s.success === false)).toBe(true);
    expect(result.message).toMatch(/timed out|failed/i);
  });

  it('5. refuses a well-formed response of the wrong shape, without retrying it', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, malformed);

    const result = await service.create('14399840');

    expect(result.verification.status).toBe(VerificationStatus.INVALID_RESPONSE);
    // One attempt only: a changed contract is not fixed by asking again.
    expect(snapshots.rows).toHaveLength(1);
    // The HTTP call worked, so the snapshot is a success — and it keeps the raw body.
    expect(snapshots.rows[0].success).toBe(true);
    expect(snapshots.rows[0].response).toEqual(malformed);
  });

  it('6. promotes the ANAF inactive flag to its own column', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, foundInactive);

    const result = await service.create('14399840');

    expect(result.verification.status).toBe(VerificationStatus.COMPLETED);
    expect(result.company?.isInactive).toBe(true);
  });

  it('7. rejects a malformed CUI before spending a request', async () => {
    // No interceptor is registered: if the service called out, disableNetConnect fails it.
    await expect(service.create('not-a-cui')).rejects.toBeInstanceOf(BadRequestException);
    expect(cases.rows).toHaveLength(0);
    expect(snapshots.rows).toHaveLength(0);
  });

  it('8. records a checksum mismatch as a warning and still performs the lookup', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, notFound);

    const result = await service.create('14399841'); // control digit deliberately wrong

    expect(snapshots.rows).toHaveLength(1);
    expect(result.verification.note).toMatch(/control digit/i);
  });

  it('9. updates an existing company instead of inserting a duplicate', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, found).times(2);

    await service.create('14399840');
    await service.create('14399840');

    expect(companies.rows).toHaveLength(1);
    expect(cases.rows).toHaveLength(2);
  });
});
