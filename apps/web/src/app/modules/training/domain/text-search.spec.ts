import { matchesTokens, normalizeText, searchTokens } from './text-search';

describe('text search', () => {
  it('drops accents and case', () => {
    expect(normalizeText('Elevação Pélvica')).toBe('elevacao pelvica');
    expect(normalizeText('ÁGUA, ÇÃO')).toBe('agua cao');
  });

  it('folds letters that Unicode does not decompose', () => {
    expect(normalizeText('Łódź Søren')).toBe('lodz soren');
  });

  it('turns punctuation and repeated spaces into a single separator', () => {
    expect(normalizeText('  Supino   c/ barra (reto) ')).toBe('supino c barra reto');
  });

  it('returns no tokens for text without letters or digits', () => {
    expect(searchTokens('  --  ')).toEqual([]);
    expect(searchTokens('')).toEqual([]);
  });

  it('matches when every word appears, in any order', () => {
    const key = normalizeText('Supino reto com barra');
    expect(matchesTokens(key, searchTokens('supino'))).toBe(true);
    expect(matchesTokens(key, searchTokens('BARRA  supíno'))).toBe(true);
    expect(matchesTokens(key, searchTokens('supino inclinado'))).toBe(false);
    expect(matchesTokens(key, [])).toBe(true);
  });
});
