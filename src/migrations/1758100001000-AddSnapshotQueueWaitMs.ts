import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * durationMs used to include the time an attempt waited for the global rate limiter,
 * so the only latency figure in the audit table measured the wrong thing. It now covers
 * the HTTP call only; the queue wait gets its own column.
 */
export class AddSnapshotQueueWaitMs1758100001000 implements MigrationInterface {
  name = 'AddSnapshotQueueWaitMs1758100001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "data_snapshots" ADD COLUMN "queueWaitMs" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "data_snapshots" DROP COLUMN "queueWaitMs"`);
  }
}
