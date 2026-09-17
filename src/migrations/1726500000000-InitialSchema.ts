import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1726500000000 implements MigrationInterface {
  name = 'InitialSchema1726500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "companies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "cui" bigint NOT NULL,
        "name" text,
        "registrationNumber" text,
        "address" text,
        "caenCode" text,
        "country" character(2) NOT NULL DEFAULT 'RO',
        "isInactive" boolean NOT NULL DEFAULT false,
        "vatPayer" boolean,
        "registeredAt" date,
        "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastCheckedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_companies" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_companies_cui" ON "companies" ("cui")`);

    await queryRunner.query(
      `CREATE TYPE "verification_status_enum" AS ENUM('COMPLETED','NOT_FOUND','SOURCE_UNAVAILABLE','INVALID_RESPONSE')`,
    );
    await queryRunner.query(`
      CREATE TABLE "verification_cases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "requestedCui" bigint NOT NULL,
        "companyId" uuid,
        "status" "verification_status_enum" NOT NULL,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "note" text,
        CONSTRAINT "PK_verification_cases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_verification_cases_company"
          FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT
      )`);
    // Postgres does not index a foreign key automatically. Without this, deleting or
    // updating a company forces a sequential scan of every verification.
    await queryRunner.query(
      `CREATE INDEX "idx_verification_cases_company_id" ON "verification_cases" ("companyId")`,
    );

    await queryRunner.query(
      `CREATE TYPE "snapshot_source_enum" AS ENUM('ANAF','TERMENE','OPENSANCTIONS')`,
    );
    await queryRunner.query(`
      CREATE TABLE "data_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "verificationCaseId" uuid NOT NULL,
        "source" "snapshot_source_enum" NOT NULL,
        "requestedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "request" jsonb NOT NULL,
        "response" jsonb,
        "success" boolean NOT NULL,
        "httpStatus" integer,
        "errorMessage" text,
        "durationMs" integer,
        "attempt" integer NOT NULL,
        CONSTRAINT "PK_data_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "FK_data_snapshots_case"
          FOREIGN KEY ("verificationCaseId") REFERENCES "verification_cases"("id") ON DELETE RESTRICT
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_data_snapshots_case_id" ON "data_snapshots" ("verificationCaseId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "data_snapshots"`);
    await queryRunner.query(`DROP TYPE "snapshot_source_enum"`);
    await queryRunner.query(`DROP TABLE "verification_cases"`);
    await queryRunner.query(`DROP TYPE "verification_status_enum"`);
    await queryRunner.query(`DROP TABLE "companies"`);
  }
}
