// Fail loudly if a test ever reaches the real network. A suite that silently calls ANAF
// is both flaky and rude to a public service.
process.env.DB_HOST = process.env.DB_HOST ?? 'localhost';
process.env.DB_PORT = process.env.DB_PORT ?? '5432';
process.env.DB_USER = process.env.DB_USER ?? 'kyb';
process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'kyb';
process.env.DB_NAME = process.env.DB_NAME ?? 'kyb';
process.env.ANAF_BASE_URL = process.env.ANAF_BASE_URL ?? 'https://webservicesp.anaf.ro/api/PlatitorTvaRest';
process.env.ANAF_API_VERSION = process.env.ANAF_API_VERSION ?? 'v9';
process.env.ANAF_TIMEOUT_MS = process.env.ANAF_TIMEOUT_MS ?? '10000';
process.env.ANAF_USER_AGENT = process.env.ANAF_USER_AGENT ?? 'KYB-Module/1.0';
process.env.ANAF_MIN_INTERVAL_MS = process.env.ANAF_MIN_INTERVAL_MS ?? '1000';
process.env.ANAF_MAX_RETRIES = process.env.ANAF_MAX_RETRIES ?? '3';
jest.setTimeout(20000);
