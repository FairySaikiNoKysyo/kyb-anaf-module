import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

const bigintToNumber = {
  to: (v: number) => v,
  from: (v: string | number | null) => (v === null ? null : Number(v)),
};

/** Directory of every company ever checked. Holds the CURRENT state only. */
@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_companies_cui', { unique: true })
  @Column({ type: 'bigint', transformer: bigintToNumber })
  cui!: number;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  registrationNumber!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'text', nullable: true })
  caenCode!: string | null;

  /** Two-character country code. 'RO' today; the column exists so other EU registers fit later. */
  @Column({ type: 'char', length: 2, default: 'RO' })
  country!: string;

  /** Red flag for risk scoring — promoted to its own column, not left in the raw snapshot. */
  @Column({ type: 'boolean', default: false })
  isInactive!: boolean;

  @Column({ type: 'boolean', nullable: true })
  vatPayer!: boolean | null;

  @Column({ type: 'date', nullable: true })
  registeredAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ type: 'timestamptz' })
  lastCheckedAt!: Date;
}
