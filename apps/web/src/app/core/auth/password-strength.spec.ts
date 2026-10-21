import { MIN_PASSWORD_LENGTH, checkPassword } from './password-strength';

describe('checkPassword', () => {
  it('treats an empty password as nothing typed yet', () => {
    expect(checkPassword('')).toEqual({ length: 0, meetsMinimum: false, variety: 0, level: 0 });
  });

  it('only the minimum length decides whether the password is enough', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(checkPassword('a'.repeat(9)).meetsMinimum).toBe(false);
    expect(checkPassword('a'.repeat(10)).meetsMinimum).toBe(true);
    // Variedade não substitui comprimento: curta e cheia de símbolos continua curta.
    const short = checkPassword('Ab1!Ab1!');
    expect(short.meetsMinimum).toBe(false);
    expect(short.level).toBe(1);
  });

  it.each([
    ['curta', 1],
    ['aaaaaaaaaaaa', 1], // cumpre o tamanho, mas é um caractere só repetido
    ['abababababab', 1],
    ['abcdefghij', 2], // o mínimo, só minúsculas
    ['abcdeabcdeabcde', 2], // 14+ caracteres, mas só 5 diferentes
    ['abcdefghijklmn', 3], // comprimento
    ['Abcdefghij1', 3], // variedade
    ['Abcdefghij1!', 3],
    ['Abcdefghijklmn1', 4], // comprimento e variedade
    ['Uma-senha-bem-longa-9!', 4],
  ])('rates %j at level %i', (password, level) => {
    expect(checkPassword(password).level).toBe(level);
  });

  it('counts accented and uppercase letters, digits and symbols as different families', () => {
    expect(checkPassword('çãoçãoçãoção').variety).toBe(1);
    expect(checkPassword('ÁguaDeCoco').variety).toBe(2);
    expect(checkPassword('ÁguaDeCoco1').variety).toBe(3);
    expect(checkPassword('ÁguaDeCoco1!').variety).toBe(4);
  });

  it('measures length the way the API does (UTF-16 units) and survives emoji', () => {
    const check = checkPassword('😀'.repeat(6));
    expect(check.length).toBe(12);
    expect(check.meetsMinimum).toBe(true);
    expect(check.level).toBe(1);
  });
});
