/**
 * Busca de texto do catálogo: sem acento e sem caixa, para "supino" achar "Supino reto" e "agachamento" achar
 * "Agachamento". É a mesma ideia da normalização do servidor (que gera o `slug`), mas esta roda só no aparelho,
 * sobre o banco local, então não precisa dar o mesmo resultado byte a byte: só ser estável entre gravar e buscar.
 */

// Letras que o Unicode não decompõe em "letra + acento" (o NFD não as simplifica sozinho).
const EXTRA_FOLDING: Readonly<Record<string, string>> = {
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
};

const EXTRA_PATTERN = new RegExp(`[${Object.keys(EXTRA_FOLDING).join('')}]`, 'gu');

/**
 * Minúsculas, sem acento, só letras e dígitos separados por um espaço. A pontuação vira separador ("c/ barra" →
 * "c barra"), e o resultado é a chave de comparação guardada em `nameKey` e usada na busca.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(EXTRA_PATTERN, (letter) => EXTRA_FOLDING[letter] ?? letter)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Palavras da busca já normalizadas; vazio quando o texto não tem nenhuma letra ou dígito. */
export function searchTokens(query: string): string[] {
  const key = normalizeText(query);
  return key === '' ? [] : key.split(' ');
}

/** Todas as palavras da busca aparecem na chave (em qualquer ordem e em qualquer parte da palavra). */
export function matchesTokens(key: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => key.includes(token));
}
