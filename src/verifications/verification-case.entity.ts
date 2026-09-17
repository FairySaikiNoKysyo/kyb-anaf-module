import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../companies/company.entity';

export enum VerificationStatus {
  COMPLETED = 'COMPLETED',
  NOT_FOUND = 'NOT_FOUND',
  SOURCE_UNAVAILABLE = 'SOURCE_UNAVAILABLE',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
}

const bigintToNumber = {
  to: (v: number) => v,
  from: (v: string | number) => Number(v),
};

/**
 * One check of one company at one point in time. The unit the supervisory authority
 * would ask to see.
 */
@Entity('verification_cases')
export class VerificationCase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** What the operator typed, after normalisation. Kept even when nothing was found. */
  @Column({ type: 'bigint', transformer: bigintToNumber })
  requestedCui!: number;

  @Index('idx_verification_cases_company_id')
  @Column({ type: 'uuid', nullable: true })
  companyId!: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'companyId' })
  company?: Company | null;

  @Column({ type: 'enum', enum: VerificationStatus })
  status!: VerificationStatus;

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  /** Human-readable outcome, shown to the operator. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;
}
