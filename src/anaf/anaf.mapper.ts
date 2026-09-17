import { AnafFoundEntry } from './anaf.schema';

/**
 * The ONLY place that knows ANAF field names.
 *
 * The specification (section 4.1) explicitly says the field list in it is not
 * authoritative and must be verified against the live service. Isolating every field
 * read here means adapting to a new ANAF version is a change to one file, not a hunt
 * through the codebase.
 *
 * The live v9 service groups fields into sub-objects (`date_generale`, `stare_inactiv`,
 * `inregistrare_scop_Tva`). Those are read FIRST. A top-level key of the same name is a
 * defensive fallback only — no real response has been seen to use it — and it must never
 * take precedence: if ANAF ever added a top-level field with a familiar name and a
 * different meaning, it would otherwise silently override the correct grouped value.
 */
const GROUPS = ['date_generale', 'stare_inactiv', 'inregistrare_scop_Tva', 'adresa_sediu_social'];

function read<T = unknown>(entry: AnafFoundEntry, field: string): T | undefined {
  for (const group of GROUPS) {
    const sub = (entry as Record<string, unknown>)[group];
    if (sub && typeof sub === 'object') {
      const value = (sub as Record<string, unknown>)[field];
      if (value !== undefined && value !== null && value !== '') return value as T;
    }
  }

  const flat = (entry as Record<string, unknown>)[field];
  if (flat !== undefined && flat !== null && flat !== '') return flat as T;
  return undefined;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
  if (typeof value === 'number') return value === 1;
  return false;
}

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface MappedCompany {
  cui: number;
  name: string | null;
  registrationNumber: string | null;
  address: string | null;
  caenCode: string | null;
  isInactive: boolean;
  vatPayer: boolean | null;
  registeredAt: Date | null;
}

export function mapAnafRecord(entry: AnafFoundEntry, requestedCui: number): MappedCompany {
  const rawCui = read<number | string>(entry, 'cui');
  const cui = rawCui !== undefined ? Number(String(rawCui).replace(/\D/g, '')) : requestedCui;

  return {
    cui: Number.isFinite(cui) && cui > 0 ? cui : requestedCui,
    name: read<string>(entry, 'denumire') ?? null,
    address: read<string>(entry, 'adresa') ?? null,
    registrationNumber: read<string>(entry, 'nrRegCom') ?? null,
    caenCode: (() => {
      const caen = read(entry, 'cod_CAEN');
      return caen === undefined ? null : String(caen);
    })(),
    // Risk flag. The specification calls an inactive company a red flag, so it gets its
    // own column instead of staying buried in the raw snapshot.
    isInactive: toBoolean(read(entry, 'statusInactivi')),
    vatPayer: (() => {
      const scp = read(entry, 'scpTVA');
      return scp === undefined ? null : toBoolean(scp);
    })(),
    registeredAt: toDate(read(entry, 'data_inregistrare')),
  };
}
