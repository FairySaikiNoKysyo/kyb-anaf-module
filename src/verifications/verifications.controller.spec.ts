import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Company } from '../companies/company.entity';
import { VerificationCase, VerificationStatus } from './verification-case.entity';
import { VerificationsController } from './verifications.controller';
import { NOT_FOUND_MESSAGE, VerificationsService } from './verifications.service';

/**
 * The HTTP contract, tested through real HTTP.
 *
 * The service is stubbed: what matters here is what a caller sees — status codes, the
 * response shape, and the global ValidationPipe configured exactly as in main.ts. The
 * pipe lives outside the controller, so a unit test of the controller class alone
 * would never exercise the 400s. No database and no network are involved.
 */
describe('VerificationsController (HTTP)', () => {
  let app: INestApplication;
  const service = { create: jest.fn(), findOne: jest.fn() };

  const verification = (status: VerificationStatus, companyId: string | null): VerificationCase =>
    Object.assign(new VerificationCase(), {
      id: '3d4a8e6c-1c2b-4f0e-9a6d-2a5f1c7b9e10',
      requestedCui: 14399840,
      companyId,
      status,
      startedAt: new Date('2026-09-17T10:00:00Z'),
      finishedAt: new Date('2026-09-17T10:00:01Z'),
      note: null,
    });

  const company = (): Company =>
    Object.assign(new Company(), {
      id: '7dc76cb4-821f-4619-b5c1-fd9f47f9a62b',
      cui: 14399840,
      name: 'DANTE INTERNATIONAL SA',
      registrationNumber: 'J2002000372404',
      address: null,
      caenCode: '4754',
      country: 'RO',
      isInactive: false,
      vatPayer: true,
      registeredAt: null,
      firstSeenAt: new Date('2026-09-17T10:00:00Z'),
      lastCheckedAt: new Date('2026-09-17T10:00:01Z'),
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VerificationsController],
      providers: [{ provide: VerificationsService, useValue: service }],
    }).compile();

    app = moduleRef.createNestApplication();
    // Same options as main.ts. If main.ts changes, this must change with it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.create.mockReset();
    service.findOne.mockReset();
  });

  it('POST returns 201 with the verification and the company when found', async () => {
    const c = company();
    service.create.mockResolvedValue({ verification: verification(VerificationStatus.COMPLETED, c.id), company: c, message: null });

    const res = await request(app.getHttpServer())
      .post('/verifications')
      .send({ cui: 'RO 14399840' })
      .expect(201);

    expect(service.create).toHaveBeenCalledWith('RO 14399840');
    expect(res.body).toMatchObject({
      id: '3d4a8e6c-1c2b-4f0e-9a6d-2a5f1c7b9e10',
      status: 'COMPLETED',
      requestedCui: 14399840,
      message: null,
      company: { cui: 14399840, name: 'DANTE INTERNATIONAL SA', isInactive: false },
    });
    expect(res.body.startedAt).toBe('2026-09-17T10:00:00.000Z');
  });

  it('POST returns 201 — not 404 — when the company is not found; the verification is the resource', async () => {
    service.create.mockResolvedValue({
      verification: verification(VerificationStatus.NOT_FOUND, null),
      company: null,
      message: NOT_FOUND_MESSAGE,
    });

    const res = await request(app.getHttpServer()).post('/verifications').send({ cui: '99999999' }).expect(201);

    expect(res.body.status).toBe('NOT_FOUND');
    expect(res.body.company).toBeNull();
    expect(res.body.message).toBe(NOT_FOUND_MESSAGE);
    expect(res.body.id).toBeDefined();
  });

  it('POST returns 201 when ANAF was unavailable; the attempt is still a created verification', async () => {
    service.create.mockResolvedValue({
      verification: verification(VerificationStatus.SOURCE_UNAVAILABLE, null),
      company: null,
      message: 'ANAF returned HTTP 503',
    });

    const res = await request(app.getHttpServer()).post('/verifications').send({ cui: '14399840' }).expect(201);
    expect(res.body.status).toBe('SOURCE_UNAVAILABLE');
  });

  it('POST rejects a numeric cui with 400 before the service is called', async () => {
    const res = await request(app.getHttpServer()).post('/verifications').send({ cui: 14399840 }).expect(400);

    expect(service.create).not.toHaveBeenCalled();
    expect(res.body.message).toEqual(expect.arrayContaining([expect.stringMatching(/cui must be a string/)]));
  });

  it('POST rejects an empty cui and unknown fields with 400', async () => {
    await request(app.getHttpServer()).post('/verifications').send({ cui: '' }).expect(400);
    await request(app.getHttpServer()).post('/verifications').send({ cui: '14399840', extra: 1 }).expect(400);
    await request(app.getHttpServer()).post('/verifications').send({}).expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST maps a malformed CUI rejected by the service to 400', async () => {
    service.create.mockRejectedValue(new BadRequestException('CUI must contain digits only (an optional RO prefix is accepted)'));

    const res = await request(app.getHttpServer()).post('/verifications').send({ cui: 'not-a-cui' }).expect(400);
    expect(res.body.message).toMatch(/digits only/);
  });

  it('GET returns the case, the company and snapshot metadata', async () => {
    const c = company();
    service.findOne.mockResolvedValue({
      verification: verification(VerificationStatus.COMPLETED, c.id),
      company: c,
      snapshots: [{ id: 's1', source: 'ANAF', requestedAt: new Date(), success: true, httpStatus: 200, durationMs: 135, queueWaitMs: 0, attempt: 1 }],
    });

    const res = await request(app.getHttpServer()).get('/verifications/3d4a8e6c-1c2b-4f0e-9a6d-2a5f1c7b9e10').expect(200);

    expect(service.findOne).toHaveBeenCalledWith('3d4a8e6c-1c2b-4f0e-9a6d-2a5f1c7b9e10');
    expect(res.body.verification.status).toBe('COMPLETED');
    expect(res.body.company.cui).toBe(14399840);
    expect(res.body.snapshots).toHaveLength(1);
    // Metadata only: the raw ANAF payload is never handed out here.
    expect(res.body.snapshots[0]).not.toHaveProperty('response');
    expect(res.body.snapshots[0]).not.toHaveProperty('request');
  });

  it('GET returns 404 for an unknown id and 400 for a non-UUID', async () => {
    service.findOne.mockResolvedValue(null);
    await request(app.getHttpServer()).get('/verifications/3d4a8e6c-1c2b-4f0e-9a6d-2a5f1c7b9e10').expect(404);

    await request(app.getHttpServer()).get('/verifications/not-a-uuid').expect(400);
    expect(service.findOne).toHaveBeenCalledTimes(1);
  });
});
