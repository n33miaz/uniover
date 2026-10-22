/**
 * Arredondamento do corpo. A tela mostra 1 casa para peso e percentual e número inteiro para quilocalorias, e o valor que
 * sobe para o servidor tem de ser o mesmo que o dono viu: por isso o arredondamento é decidido aqui, uma vez.
 *
 * `Math.round(x * 10)` erra em casos como `1.005` (a conta binária dá 100.49999...). O truque é arredondar sobre a
 * representação decimal curta do número (notação `e`), depois de limpar o ruído de ponto flutuante de uma conta longa
 * (`toPrecision(12)`): `16.849999999999998` volta a ser `16.85` e arredonda para `16.9`.
 */

/** Arredonda para `digits` casas, meio para longe do zero. Nunca devolve `-0`. */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const magnitude = Number(Math.abs(value).toPrecision(12));
  const shifted = Math.round(Number(`${magnitude}e${digits}`));
  const result = Number(`${shifted}e${-digits}`) * Math.sign(value);
  return result === 0 ? 0 : result;
}

/** Peso, gordura e medidas: 1 casa. */
export const round1 = (value: number): number => roundTo(value, 1);

/** Quilocalorias: inteiro. */
export const roundKcal = (value: number): number => roundTo(value, 0);
