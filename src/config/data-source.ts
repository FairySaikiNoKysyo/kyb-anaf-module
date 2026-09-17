import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadConfig } from './configuration';
import { Company } from '../companies/company.entity';
import { DataSnapshot } from '../verifications/data-snapshot.entity';
import { VerificationCase } from '../verifications/verification-case.entity';
import { InitialSchema1726500000000 } from '../migrations/1726500000000-InitialSchema';

const config = loadConfig();

/**
 * synchronize is false and stays false. This is financial-sector data: schema changes
 * belong in reviewed migration files, never in an ORM guessing at runtime.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: config.db.host,
  port: config.db.port,
  username: config.db.user,
  password: config.db.password,
  database: config.db.name,
  synchronize: false,
  logging: false,
  entities: [Company, VerificationCase, DataSnapshot],
  migrations: [InitialSchema1726500000000],
});
