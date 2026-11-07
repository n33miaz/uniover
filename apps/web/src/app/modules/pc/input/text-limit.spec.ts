import { clampText } from './text-limit';

describe('clampText', () => {
  it('lets text that fits go through untouched', () => {
    expect(clampText('olá, mundo', 200)).toBe('olá, mundo');
    expect(clampText('', 200)).toBe('');
  });

  it('counts code points: a text of 200 emoji fits although it has 400 UTF-16 units', () => {
    const text = '😀'.repeat(200);
    expect(text.length).toBe(400);
    expect(clampText(text, 200)).toBe(text);
  });

  it('cuts at the limit without splitting a surrogate pair', () => {
    const cut = clampText('ab😀cd', 3);
    expect(cut).toBe('ab😀');
    expect(clampText('abc😀', 3)).toBe('abc');
    // Nunca sobra metade de um emoji.
    expect(/[\uD800-\uDFFF]/.test(clampText('a😀', 1))).toBe(false);
  });

  it('drops half a pair left by a cut made in UTF-16 units (a paste cut by the browser)', () => {
    const half = '😀'.slice(0, 1);
    expect(clampText(`abc${half}`, 200)).toBe('abc');
    expect(clampText(`${'😀'.slice(1)}abc`, 200)).toBe('abc');
  });

  it('keeps accents and combining marks as typed', () => {
    expect(clampText('ação é café', 200)).toBe('ação é café');
  });
});
