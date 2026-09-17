import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum SnapshotSource {
  ANAF = 'ANAF',
  TERMENE = 'TERMENE',
  OPENSANCTIONS = 'OPENSANCTIONS',
}

/**
 * One request to one external source, stored exactly as it came back.
 *
 * APPEND-ONLY BY CONTRACT. Snapshots are never updated and never deleted: re-checking a
 * company creates new snapshots, it does not overwrite old ones. That immutability is
 * the reason the record is worth anything to a regulator — a dossier that can be edited
 * after the fact proves nothing. Nothing in this codebase exposes update or delete for
 * this entity, and nothing should.
 *
 * Failed attempts are stored too: they are the evidence that the check was attempted.
 */
@Entity('data_snapshots')
export class DataSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_data_snapshots_case_id')
  @Column({ type: 'uuid' })
  verificationCaseId!: string;

  @Column({ type: 'enum', enum: SnapshotSource })
  source!: SnapshotSource;

  @Column({ type: 'timestamptz' })
  requestedAt!: Date;

  /** Exactly what was asked: method, url, body. */
  @Column({ type: 'jsonb' })
  request!: Record<string, unknown>;

  /** The source's answer, unmodified. Null only when nothing came back at all. */
  @Column({ type: 'jsonb', nullable: true })
  response!: unknown | null;

  /** Whether the HTTP call itself succeeded. A "not found" answer is a SUCCESS. */
  @Column({ type: 'boolean' })
  success!: boolean;

  @Column({ type: 'int', nullable: true })
  httpStatus!: number | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  /** HTTP call only; the limiter queue wait is recorded separately in queueWaitMs. */
  @Column({ type: 'int', nullable: true })
  durationMs!: number | null;

  /** Time spent waiting for the global ANAF rate limiter before this attempt was sent. */
  @Column({ type: 'int', nullable: true })
  queueWaitMs!: number | null;

  @Column({ type: 'int' })
  attempt!: number;
}
