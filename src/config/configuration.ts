import * as dotenv from 'dotenv';
import { z } from 'zod';

// Loaded once, at import time, so the CLI (migrations) and the Nest app read the same
// file. Real deployments inject variables directly; .env is a local-development
// convenience and is never committed.
dotenv.config();

/**
 * Environment is validated once, at startup, and the process refuses to boot on a bad
 * value. A misconfigured external-service URL or timeout must fail loudly here rather
 * than silently at the first customer request.
 */
const envSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),

  ANAF_BASE_URL: z.string().url(),
  ANAF_API_VERSION: z.string().min(1),
  ANAF_TIMEOUT_MS: z.coerce.number().int().positive(),
  ANAF_USER_AGENT: z.string().min(1),
  ANAF_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative(),
  ANAF_MAX_RETRIES: z.coerce.number().int().min(1).max(10),

  PORT: z.coerce.number().int().positive().default(3000),
});

export type AppConfig = {
  db: { host: string; port: number; user: string; password: string; name: string };
  anaf: {
    baseUrl: string;
    apiVersion: string;
    timeoutMs: number;
    userAgent: string;
    minIntervalMs: number;
    maxRetries: number;
  };
  port: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    db: { host: e.DB_HOST, port: e.DB_PORT, user: e.DB_USER, password: e.DB_PASSWORD, name: e.DB_NAME },
    anaf: {
      baseUrl: e.ANAF_BASE_URL.replace(/\/+$/, ''),
      apiVersion: e.ANAF_API_VERSION,
      timeoutMs: e.ANAF_TIMEOUT_MS,
      userAgent: e.ANAF_USER_AGENT,
      minIntervalMs: e.ANAF_MIN_INTERVAL_MS,
      maxRetries: e.ANAF_MAX_RETRIES,
    },
    port: e.PORT,
  };
}
