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
    // Values from the real ANAF response captured in test/fixtures/anaf-found.json.
    expect(result.company?.cui).toBe(14399840);
    expect(result.company?.name).toBe('DANTE INTERNATIONAL SA');
    expect(result.company?.registrationNumber).toBe('J2002000372404');
    expect(result.company?.caenCode).toBe('4754');
    expect(result.company?.isInactive).toBe(false);
    expect(result.company?.vatPayer).toBe(true);
    expect(result.company?.registeredAt?.toISOString().slice(0, 10)).toBe('2002-01-23');
    expect(companies.rows).toHaveLength(1);
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0].success).toBe(true);
    expect(result.verification.companyId).toBe(result.company?.id);
  });

  it('1b. inserts the case as PENDING and only moves to a terminal status once the lookup resolves', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, found).delay(150);

    const pending = service.create('14399840');
    await new Promise((r) => setTimeout(r, 50)); // lookup is in flight

    expect(cases.rows).toHaveLength(1);
    expect(cases.rows[0].status).toBe(VerificationStatus.PENDING);
    expect(cases.rows[0].finishedAt).toBeNull();

    const result = await pending;
    expect(result.verification.status).toBe(VerificationStatus.COMPLETED);
    expect(result.verification.finishedAt).toBeInstanceOf(Date);
  });

  it('2. treats "not found" as a business result, not an error', async () => {
    // Verified against the live service: an unknown CUI is HTTP 404 with the normal
    // envelope, not 200. Serving it with 200 here would let a client that treats every
    // non-2xx as an outage pass this test and be wrong in production.
    pool().intercept({ path: PATH, method: 'POST' }).reply(404, notFound);

    const result = await service.create('99999999');

    expect(result.verification.status).toBe(VerificationStatus.NOT_FOUND);
    expect(result.company).toBeNull();
    expect(companies.rows).toHaveLength(0);
    expect(result.message).toContain(NOT_FOUND_MESSAGE);
    // The HTTP call itself succeeded, so the snapshot is a success — with the real status.
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0].success).toBe(true);
    expect(snapshots.rows[0].httpStatus).toBe(404);
    expect(snapshots.rows[0].response).toEqual(notFound);
    // The verification still exists — that record is the point of the module.
    expect(result.verification.id).toBeDefined();
    expect(result.verification.finishedAt).toBeInstanceOf(Date);
  });

  it('2b. does not mistake a 404 without the ANAF envelope for "not found"', async () => {
    // What a wrong endpoint path returns (observed live on /v10/tva): problem+json.
    const routing404 = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No endpoint POST /PlatitorTvaRest/v10/tva.',
      instance: '/PlatitorTvaRest/v10/tva',
    };
    pool().intercept({ path: PATH, method: 'POST' }).reply(404, routing404);

    const result = await service.create('14399840');

    expect(result.verification.status).toBe(VerificationStatus.SOURCE_UNAVAILABLE);
    expect(result.company).toBeNull();
    // Not retried: 4xx other than 429 will not become a success.
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0].success).toBe(false);
    expect(snapshots.rows[0].httpStatus).toBe(404);
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
    // The client aborts at 300 ms (see build()). The mock's delay is just past that so the
    // timeout fires, but the mock timers finish soon after and do not outlive the worker.
    const MOCK_DELAY_MS = 320;
    pool()
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, found)
      .delay(MOCK_DELAY_MS)
      .times(3);

    const result = await service.create('14399840');
    // Drain the last mock timer before afterEach closes the agent.
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));

    expect(result.verification.status).toBe(VerificationStatus.SOURCE_UNAVAILABLE);
    expect(snapshots.rows).toHaveLength(3);
    expect(snapshots.rows.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(snapshots.rows.every((s) => s.success === false && s.httpStatus === null)).toBe(true);
    expect(result.message).toMatch(/timed out/i);
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

  it('5b. does not call a company "not found" unless ANAF lists that CUI in notFound', async () => {
    // A well-formed envelope that says nothing about the requested CUI.
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, { found: [], notFound: [] });

    const result = await service.create('14399840');

    expect(result.verification.status).toBe(VerificationStatus.INVALID_RESPONSE);
    expect(result.message).not.toContain(NOT_FOUND_MESSAGE);
    expect(result.company).toBeNull();
    expect(snapshots.rows).toHaveLength(1); // one attempt, raw body kept
    expect(snapshots.rows[0].success).toBe(true);
  });

  it('5c. refuses a found record that is about a different CUI', async () => {
    // Real record for 18000054 served for a request about 14399840.
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, foundInactive);

    const result = await service.create('14399840');

    expect(result.verification.status).toBe(VerificationStatus.INVALID_RESPONSE);
    expect(result.message).toMatch(/18000054/);
    expect(result.company).toBeNull();
    expect(companies.rows).toHaveLength(0);
  });

  it('6. promotes the ANAF inactive flag to its own column', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, foundInactive);

    const result = await service.create('18000054');

    expect(result.verification.status).toBe(VerificationStatus.COMPLETED);
    expect(result.company?.cui).toBe(18000054);
    expect(result.company?.isInactive).toBe(true);
    // A deregistered VAT payer: the real record has scpTVA=false.
    expect(result.company?.vatPayer).toBe(false);
  });

  it('7. rejects a malformed CUI before spending a request', async () => {
    // No interceptor is registered: if the service called out, disableNetConnect fails it.
    await expect(service.create('not-a-cui')).rejects.toBeInstanceOf(BadRequestException);
    expect(cases.rows).toHaveLength(0);
    expect(snapshots.rows).toHaveLength(0);
  });

  it('8. records a checksum mismatch as a warning and still performs the lookup', async () => {
    // Same shape as the captured not-found fixture, for the CUI this test asks about.
    pool().intercept({ path: PATH, method: 'POST' }).reply(404, { found: [], notFound: [14399841] });

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
