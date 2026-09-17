import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A verification is inserted before the external lookup starts. Until now it was
 * inserted as SOURCE_UNAVAILABLE, so a process crash mid-lookup left a permanent record
 * claiming an outage that never happened. PENDING says what is actually true.
 */
export class AddPendingStatus1758100000000 implements MigrationInterface {
  name = 'AddPendingStatus1758100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "verification_status_enum" ADD VALUE IF NOT EXISTS 'PENDING'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop a single enum value; rebuild the type without it.
    await queryRunner.query(
      `UPDATE "verification_cases" SET "status" = 'SOURCE_UNAVAILABLE' WHERE "status" = 'PENDING'`,
    );
    await queryRunner.query(`ALTER TYPE "verification_status_enum" RENAME TO "verification_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "verification_status_enum" AS ENUM('COMPLETED','NOT_FOUND','SOURCE_UNAVAILABLE','INVALID_RESPONSE')`,
    );
    await queryRunner.query(
      `ALTER TABLE "verification_cases" ALTER COLUMN "status" TYPE "verification_status_enum" USING "status"::text::"verification_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "verification_status_enum_old"`);
  }
}
