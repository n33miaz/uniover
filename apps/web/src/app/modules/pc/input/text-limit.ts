/** Metade de um par substituto sem a outra: não é texto válido e a API não o aceita. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Corta o texto em `max` pontos de código, nunca no meio de um par substituto (um emoji), e tira pedaços de par soltos
 * (um corte de colar feito pelo navegador por unidades de 16 bits). O que cabe passa inteiro.
 */
export function clampText(text: string, max: number): string {
  const clean = text.replace(LONE_SURROGATE, '');
  let end = 0;
  let count = 0;
  for (const point of clean) {
    if (count === max) return clean.slice(0, end);
    end += point.length;
    count++;
  }
  return clean;
}
