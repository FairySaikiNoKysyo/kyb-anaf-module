import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnafClient } from './anaf/anaf.client';
import { AnafRateLimiter } from './common/rate-limit/anaf-rate-limiter';
import { Company } from './companies/company.entity';
import { loadConfig } from './config/configuration';
import { DataSnapshot } from './verifications/data-snapshot.entity';
import { VerificationCase } from './verifications/verification-case.entity';
import { VerificationsController } from './verifications/verifications.controller';
import { VerificationsService } from './verifications/verifications.service';
import { InitialSchema1726500000000 } from './migrations/1726500000000-InitialSchema';
import { AddPendingStatus1758100000000 } from './migrations/1758100000000-AddPendingStatus';
import { AddSnapshotQueueWaitMs1758100001000 } from './migrations/1758100001000-AddSnapshotQueueWaitMs';

const config = loadConfig();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: config.db.host,
      port: config.db.port,
      username: config.db.user,
      password: config.db.password,
      database: config.db.name,
      entities: [Company, VerificationCase, DataSnapshot],
      migrations: [InitialSchema1726500000000, AddPendingStatus1758100000000, AddSnapshotQueueWaitMs1758100001000],
      synchronize: false,
    }),
    TypeOrmModule.forFeature([Company, VerificationCase, DataSnapshot]),
  ],
  controllers: [VerificationsController],
  providers: [
    {
      // One shared limiter for the whole process: the ANAF budget belongs to the
      // service, not to a request or a user.
      provide: AnafRateLimiter,
      useFactory: () => new AnafRateLimiter(config.anaf.minIntervalMs),
    },
    {
      provide: AnafClient,
      inject: [AnafRateLimiter],
      useFactory: (limiter: AnafRateLimiter) =>
        new AnafClient(
          {
            baseUrl: config.anaf.baseUrl,
            apiVersion: config.anaf.apiVersion,
            timeoutMs: config.anaf.timeoutMs,
            userAgent: config.anaf.userAgent,
            maxRetries: config.anaf.maxRetries,
          },
          limiter,
        ),
    },
    {
      provide: VerificationsService,
      inject: [DataSource, AnafClient],
      useFactory: (dataSource: DataSource, anaf: AnafClient) =>
        new VerificationsService(
          dataSource.getRepository(VerificationCase),
          dataSource.getRepository(DataSnapshot),
          dataSource.getRepository(Company),
          anaf,
        ),
    },
  ],
})
export class AppModule {}
