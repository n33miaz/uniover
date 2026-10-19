import { safeNextUrl } from './next-url';

const ORIGIN = 'https://uniover.exemplo.app';

describe('safeNextUrl', () => {
  it.each(['/', '/tv', '/tv/', '/ajustes?aba=seguranca', '/treino#topo', '/a/b/c'])(
    'accepts the same-origin path %s',
    (path) => expect(safeNextUrl(path, ORIGIN)).toBe(path),
  );

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['number', 3],
    ['relative without slash', 'tv'],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/tv'],
    ['backslash authority', '/\\evil.com'],
    ['backslash anywhere', '/tv\\..\\x'],
    ['absolute http', 'http://evil.com'],
    ['absolute same origin', `${ORIGIN}/tv`],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,x'],
    ['encoded double slash', '/%2F%2Fevil.com'],
    ['encoded backslash', '/%5Cevil.com'],
    ['encoded slash after slash', '/%2fevil.com/%2f'],
    ['tab inside', '/\t/evil.com'],
    ['newline inside', '/tv\n'],
    ['null byte', '/tv\u0000'],
    ['broken encoding', '/%E0%A4%A'],
    ['the sign-in page itself', '/entrar'],
    ['the sign-in page with query', '/entrar?next=/tv'],
    ['too long', '/' + 'a'.repeat(600)],
  ])('rejects %s', (_label, candidate) => {
    expect(safeNextUrl(candidate, ORIGIN)).toBeNull();
  });
});
