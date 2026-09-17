/** Raised when the input cannot be a CUI at all. Never raised for a bad checksum. */
export class InvalidCuiError extends Error {}

export interface NormalizedCui {
  /** Numeric CUI, RO prefix and whitespace removed. This is what ANAF expects. */
  value: number;
  /**
   * Result of the control-digit check.
   *
   * Deliberately a WARNING and not a rejection: a bug in our own checksum
   * implementation would reject valid companies and block real business, whereas the
   * cost of being wrong the other way is a single extra call to a free service.
   * Failing open is the cheaper mistake here, so the value is surfaced and recorded
   * rather than enforced.
   */
  checksumValid: boolean;
}

const CONTROL_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];

/** Romanian CUI control digit, key 753217532. */
export function isCuiChecksumValid(cui: number): boolean {
  const digits = String(cui);
  if (digits.length < 2) return false;
  const control = Number(digits[digits.length - 1]);
  const body = digits.slice(0, -1).padStart(CONTROL_KEY.length, '0');
  if (body.length > CONTROL_KEY.length) return false;

  let sum = 0;
  for (let i = 0; i < CONTROL_KEY.length; i++) {
    sum += Number(body[i]) * CONTROL_KEY[i];
  }
  const computed = (sum * 10) % 11;
  return (computed === 10 ? 0 : computed) === control;
}

export function normalizeCui(raw: string): NormalizedCui {
  if (typeof raw !== 'string') throw new InvalidCuiError('CUI must be a string');

  const cleaned = raw.replace(/\s+/g, '').replace(/^RO/i, '');
  if (cleaned.length === 0) throw new InvalidCuiError('CUI is empty');
  if (!/^\d+$/.test(cleaned)) throw new InvalidCuiError('CUI must contain digits only (an optional RO prefix is accepted)');
  if (cleaned.length < 2 || cleaned.length > 10) {
    throw new InvalidCuiError('CUI must be between 2 and 10 digits long');
  }

  const value = Number(cleaned);
  return { value, checksumValid: isCuiChecksumValid(value) };
}
