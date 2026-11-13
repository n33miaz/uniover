import { ECHO_MAX_TOKENS, ECHO_VISIBLE_TOKENS, TypedEcho, keyLabel } from './typed-echo';

/** O eco como uma linha só: as teclas entre colchetes. */
const line = (echo: TypedEcho) =>
  echo
    .view()
    .map((segment) => (segment.kind === 'key' ? `[${segment.value}]` : segment.value))
    .join('');

describe('TypedEcho', () => {
  it('shows what is typed, accents and emoji included', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'olá' });
    echo.edit({ erase: 0, insert: ' 😀' });
    expect(line(echo)).toBe('olá 😀');
  });

  it('erasing removes code points from the end, emoji as one', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'oi 😀' });
    echo.edit({ erase: 1, insert: '' });
    expect(line(echo)).toBe('oi ');
    echo.edit({ erase: 2, insert: 'k' });
    expect(line(echo)).toBe('ok');
  });

  it('a line break and a tab in the text show as the keys the PC receives', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'a\r\nb\tc' });
    expect(line(echo)).toBe('a[⏎]b[⇥]c');
  });

  it('control characters the PC never receives do not show', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'a\u0007b' });
    expect(line(echo)).toBe('ab');
  });

  it('special keys show as short symbols', () => {
    const echo = new TypedEcho();
    for (const key of [
      'ENTER',
      'TAB',
      'UP',
      'DOWN',
      'LEFT',
      'RIGHT',
      'ESCAPE',
      'DELETE',
    ] as const) {
      echo.key(key);
    }
    expect(line(echo)).toBe('[⏎][⇥][↑][↓][←][→][Esc][⌦]');
  });

  it('keys that type a character show as the character', () => {
    const echo = new TypedEcho();
    for (const key of ['D1', 'SPACE', 'MINUS', 'PERIOD', 'Q'] as const) echo.key(key);
    expect(line(echo)).toBe('1 -.q');
  });

  it('Backspace takes back a character, an Enter or a Tab', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'ab' });
    echo.key('ENTER');
    echo.key('BACKSPACE');
    expect(line(echo)).toBe('ab');
    echo.key('TAB');
    echo.repeat('BACKSPACE', 2);
    expect(line(echo)).toBe('a');
  });

  it('after an arrow the caret moved: Backspace shows as its symbol instead of guessing', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'abc' });
    echo.key('LEFT');
    echo.key('BACKSPACE');
    echo.edit({ erase: 1, insert: '' });
    expect(line(echo)).toBe('abc[←][⌫][⌫]');
  });

  it('Backspace with nothing typed shows nothing', () => {
    const echo = new TypedEcho();
    echo.key('BACKSPACE');
    echo.edit({ erase: 3, insert: '' });
    expect(echo.empty).toBe(true);
    expect(echo.view()).toEqual([]);
  });

  it('erasing more than was typed just empties the echo', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'ab' });
    echo.edit({ erase: 10, insert: 'x' });
    expect(line(echo)).toBe('x');
  });

  it('a key with modifiers shows as the combination and cannot be erased', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'a' });
    echo.key('C', ['CTRL']);
    echo.key('BACKSPACE', ['CTRL']);
    echo.key('BACKSPACE');
    expect(line(echo)).toBe('a[Ctrl+C][Ctrl+⌫][⌫]');
  });

  it('Shift with a letter is the capital letter', () => {
    const echo = new TypedEcho();
    echo.key('A', ['SHIFT']);
    echo.key('BACKSPACE');
    echo.key('B', ['SHIFT']);
    expect(line(echo)).toBe('B');
  });

  it('names combinations the way the PC keyboard does', () => {
    expect(keyLabel('V', ['CTRL', 'SHIFT'])).toBe('Ctrl+Shift+V');
    expect(keyLabel('SPACE', ['CTRL'])).toBe('Ctrl+Espaço');
    expect(keyLabel('F4', ['ALT'])).toBe('Alt+F4');
  });

  it('a failed send leaves a warning that Backspace does not take back', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'ab' });
    echo.failed();
    echo.key('BACKSPACE');
    expect(line(echo)).toBe('ab[⚠][⌫]');
  });

  it('clearing forgets everything', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'segredo' });
    echo.key('ENTER');
    echo.clear();
    expect(echo.empty).toBe(true);
    expect(echo.all).toEqual([]);
  });

  it('keeps only the end, and the screen gets an even shorter end', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'x'.repeat(ECHO_MAX_TOKENS + 50) + 'fim' });
    expect(echo.all).toHaveLength(ECHO_MAX_TOKENS);
    const shown = line(echo);
    expect(shown).toHaveLength(ECHO_VISIBLE_TOKENS);
    expect(shown.endsWith('fim')).toBe(true);
  });

  it('joins the characters in a row into one segment for the screen', () => {
    const echo = new TypedEcho();
    echo.edit({ erase: 0, insert: 'ab' });
    echo.key('ENTER');
    echo.edit({ erase: 0, insert: 'cd' });
    expect(echo.view()).toEqual([
      { kind: 'text', value: 'ab' },
      { kind: 'key', value: '⏎' },
      { kind: 'text', value: 'cd' },
    ]);
  });
});
