import { z } from 'zod';

/**
 * Shape of the ANAF response.
 *
 * Deliberately permissive about unknown keys and strict only about the envelope. Two
 * reasons: ANAF adds fields between versions, and the specification (section 4.1) warns
 * that the field list in it must not be treated as final. What must never happen is the
 * opposite failure — silently accepting a response whose shape changed and writing
 * garbage into a compliance dossier. So the envelope is validated, the record itself is
 * kept raw, and every field read happens in one place (anaf.mapper.ts).
 */
/**
 * Verified against the live v9 service: `notFound` is an array of BARE numbers
 * (`{"found":[],"notFound":[99999999]}`), not of objects. The object form is kept as a
 * fallback because the specification's own example uses it.
 */
export const anafNotFoundEntrySchema = z.union([
  z.number(),
  z.string(),
  z.object({ cui: z.union([z.number(), z.string()]).optional() }).passthrough(),
]);

export const anafFoundEntrySchema = z.record(z.unknown());

export const anafResponseSchema = z
  .object({
    cod: z.number().optional(),
    message: z.string().optional(),
    found: z.array(anafFoundEntrySchema).default([]),
    notFound: z.array(anafNotFoundEntrySchema).default([]),
  })
  .passthrough();

export type AnafResponse = z.infer<typeof anafResponseSchema>;
export type AnafFoundEntry = z.infer<typeof anafFoundEntrySchema>;
