import { InvalidCuiError, isCuiChecksumValid, normalizeCui } from './cui.util';

describe('normalizeCui', () => {
  it.each([
    ['RO 14399840', 14399840],
    ['ro14399840', 14399840],
    ['  14399840  ', 14399840],
    ['RO14399840', 14399840],
  ])('normalises %s to %i', (input, expected) => {
    expect(normalizeCui(input).value).toBe(expected);
  });

  it.each(['', '   ', 'RO', 'abc', '12ab34', '1', '12345678901'])(
    'rejects %p',
    (input) => {
      expect(() => normalizeCui(input)).toThrow(InvalidCuiError);
    },
  );

  it('reports a checksum result without ever throwing on a bad one', () => {
    const result = normalizeCui('19'); // deliberately not a real CUI
    expect(result.value).toBe(19);
    expect(typeof result.checksumValid).toBe('boolean');
  });
});

describe('isCuiChecksumValid', () => {
  it('accepts a CUI whose control digit matches', () => {
    // 14399840 is a well-formed Romanian CUI used throughout the fixtures.
    expect(isCuiChecksumValid(14399840)).toBe(true);
  });

  it('rejects the same CUI with a corrupted control digit', () => {
    expect(isCuiChecksumValid(14399841)).toBe(false);
  });
});
