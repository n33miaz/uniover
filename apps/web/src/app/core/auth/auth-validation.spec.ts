import { isPlausibleEmail } from './auth-validation';

describe('isPlausibleEmail', () => {
  it.each(['dono@exemplo.com', '  ana@exemplo.com  ', 'a@b', 'nome+tag@sub.exemplo.com.br'])(
    'accepts %j',
    (email) => expect(isPlausibleEmail(email)).toBe(true),
  );

  it.each([
    '',
    '   ',
    'ana',
    '@exemplo.com',
    'ana@',
    'ana@@exemplo.com',
    'a@b@c.com',
    'ana silva@exemplo.com',
    `${'a'.repeat(250)}@b.com`,
  ])('rejects %j (same shape rule as the API)', (email) => {
    expect(isPlausibleEmail(email)).toBe(false);
  });
});
