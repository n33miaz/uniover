import {
  formatCodeInput,
  isValidDeviceName,
  isValidTvNickname,
  normalizeCode,
} from './pairing-code';

describe('pairing code', () => {
  it.each(['BCDF-2345', 'bcdf-2345', 'BCDF2345', 'bcdf 2345', '  bcdf2345  ', 'bc-df-23-45'])(
    'normalizes %j to the stored form',
    (input) => {
      expect(normalizeCode(input)).toBe('BCDF2345');
    },
  );

  it.each([
    '',
    'BCDF-234',
    'BCDF-23456',
    'ABCD-2345', // vogal
    'BCDF-0123', // 0 e 1
    'BCDF-23$5',
  ])('rejects %j', (input) => {
    expect(normalizeCode(input)).toBeNull();
  });

  it('formats while typing: uppercase, no symbols, hyphen after the fourth, at most eight', () => {
    expect(formatCodeInput('bc')).toBe('BC');
    expect(formatCodeInput('bcdf')).toBe('BCDF');
    expect(formatCodeInput('bcdf2')).toBe('BCDF-2');
    expect(formatCodeInput('bc df-2345 99')).toBe('BCDF-2345');
  });

  it('validates the device name like the API', () => {
    expect(isValidDeviceName('')).toBe(true);
    expect(isValidDeviceName('  ')).toBe(true);
    expect(isValidDeviceName('PC de casa')).toBe(true);
    expect(isValidDeviceName('Sala (TV) 2.0')).toBe(true);
    expect(isValidDeviceName('-comeca-mal')).toBe(false);
    expect(isValidDeviceName('com <tag>')).toBe(false);
    expect(isValidDeviceName('a'.repeat(61))).toBe(false);
    expect(isValidDeviceName('a'.repeat(60))).toBe(true);
  });

  it('asks for a short TV nickname: empty is fine, the API rules apply, and 20 is the most', () => {
    expect(isValidTvNickname('')).toBe(true);
    expect(isValidTvNickname('Sala')).toBe(true);
    expect(isValidTvNickname('a'.repeat(20))).toBe(true);
    expect(isValidTvNickname('a'.repeat(21))).toBe(false);
    expect(isValidTvNickname('-sala')).toBe(false);
    expect(isValidTvNickname('<b>')).toBe(false);
  });
});
