import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terminal status for a verification that stayed PENDING past the configured timeout:
 * the process died between inserting the case and writing its outcome. Set by
 * StaleVerificationReaper, never by the request path.
 */
export class AddInterruptedStatus1758100002000 implements MigrationInterface {
  name = 'AddInterruptedStatus1758100002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "verification_status_enum" ADD VALUE IF NOT EXISTS 'INTERRUPTED'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "verification_cases" SET "status" = 'SOURCE_UNAVAILABLE' WHERE "status" = 'INTERRUPTED'`,
    );
    await queryRunner.query(`ALTER TYPE "verification_status_enum" RENAME TO "verification_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "verification_status_enum" AS ENUM('COMPLETED','NOT_FOUND','SOURCE_UNAVAILABLE','INVALID_RESPONSE','PENDING')`,
    );
    await queryRunner.query(
      `ALTER TABLE "verification_cases" ALTER COLUMN "status" TYPE "verification_status_enum" USING "status"::text::"verification_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "verification_status_enum_old"`);
  }
}
