import { categorize, type CategoryKey } from './shopping-categories';
import { MAX_MONEY } from './shopping-model';

/**
 * O campo único do mercado: "leite 5,49", "arroz 5kg 24,90", "banana 1,2kg 6,99", "leite 2 5,49", "12 ovos". Lê de uma
 * vez o nome, a quantidade e o preço (da embalagem; por quilo só quando o item é a granel).
 *
 * Regras, nesta ordem:
 * - "promo", "promoção" ou "oferta" em qualquer lugar marcam a promoção e saem do nome.
 * - O preço é o último número com centavos ("5,49", "5.49"), com ou sem "R$", ou um inteiro com "R$" ("R$ 10").
 *   "/kg" logo depois do preço ("6,99/kg") diz que ele é por quilo.
 * - Peso a granel (quantidade em kg) só no Hortifrúti, nas Carnes ou com "/kg": "banana 1,2kg 6,99", "tomate 1,2kg
 *   6,99/kg". Gramas viram quilos (500 g = 0,5 kg). Fora disso, peso, volume e unidades da embalagem ficam no nome e o
 *   preço é o da embalagem: "arroz 5kg 24,90" é um pacote de 5 kg ("Arroz 5kg"), não 5 quilos.
 * - A quantidade vem com "x" ("2x", "x2", "2 x"), no começo ("12 ovos") ou num inteiro sozinho no fim, sem "R$" e sem
 *   vírgula ("pão 10", "leite 2 5,49"): esse inteiro nunca é preço.
 */
export interface ParsedEntry {
  readonly name: string;
  readonly quantity: number;
  /** `kg` quando a quantidade é peso a granel; ausente quando é em unidades. */
  readonly unit: 'kg' | null;
  /** Preço por unidade (ou por quilo, a granel), em reais. */
  readonly unitPrice: number | null;
  readonly promo: boolean;
}

const MAX_QUANTITY = 999_999.999;

/** As categorias em que o peso digitado é o que vai na sacola (pesado na hora), não o tamanho da embalagem. */
const BULK: readonly CategoryKey[] = ['hortifruti', 'carnes'];

const PROMO = /^(promo|promocao|promoção|oferta)$/i;
const MONEY_CENTS = /^(?:r\$)?(\d{1,7})[,.](\d{1,2})$/i;
const MONEY_WHOLE = /^r\$(\d{1,7})$/i;
const PER_KG = /^(.*\d)\/kg$/i;
const TIMES = /^(?:(\d+(?:[,.]\d+)?)x|x(\d+(?:[,.]\d+)?))$/i;
const WEIGHT = /^(\d+(?:[,.]\d+)?)(kg|g)$/i;
const NUMBER = /^\d+(?:[,.]\d+)?$/;
const INTEGER = /^\d{1,7}$/;

function toNumber(text: string): number {
  return Number(text.replace(',', '.'));
}

/**
 * Junta "R$ 5,49", "2 x", "500 g", "6 un" e "6,99 /kg" num pedaço só, para as regras valerem com ou sem espaço.
 */
function tokens(text: string): string[] {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const current = raw[i];
    const next = raw[i + 1];
    if (/^r\$$/i.test(current) && next && /^\d/.test(next)) {
      out.push(`R$${next}`);
      i++;
    } else if (NUMBER.test(current) && next && /^(x|kg|g|un|und|unid)$/i.test(next)) {
      out.push(`${current}${next}`);
      i++;
    } else if (/^\/kg$/i.test(current) && out.length > 0 && /\d$/.test(out[out.length - 1])) {
      out[out.length - 1] += '/kg';
    } else {
      out.push(current);
    }
  }
  return out;
}

function capitalize(name: string): string {
  return name.charAt(0).toLocaleUpperCase('pt-BR') + name.slice(1);
}

/**
 * Lê o que foi digitado. Sem nome (só números), devolve `null`: não há o que pôr na lista. `categoryOf` diz a categoria
 * do nome (a do produto que já existe, se houver); sem ela, vale a tabela de categorias.
 */
export function parseEntry(
  text: string,
  categoryOf: (name: string) => CategoryKey = categorize,
): ParsedEntry | null {
  let parts = tokens(text);
  let promo = false;
  parts = parts.filter((part) => {
    if (PROMO.test(part)) {
      promo = true;
      return false;
    }
    return true;
  });

  // "/kg" em qualquer pedaço com número: o preço é por quilo, e o peso é a granel.
  let perKg = false;
  parts = parts.map((part) => {
    const match = PER_KG.exec(part);
    if (!match) return part;
    perKg = true;
    return match[1];
  });

  let unitPrice: number | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const cents = MONEY_CENTS.exec(parts[i]);
    const whole = MONEY_WHOLE.exec(parts[i]);
    if (cents || whole) {
      unitPrice = cents ? toNumber(`${cents[1]}.${cents[2]}`) : toNumber(whole![1]);
      parts.splice(i, 1);
      break;
    }
  }

  let quantity: number | null = null;
  const timesAt = parts.findIndex((part) => TIMES.test(part));
  if (timesAt >= 0) {
    const times = TIMES.exec(parts[timesAt])!;
    quantity = toNumber(times[1] ?? times[2]);
    parts.splice(timesAt, 1);
  }

  // O peso só sai do nome quando é a granel; a categoria é a do nome sem ele ("tomate 1,2kg" é "tomate").
  let unit: 'kg' | null = null;
  const weightAt = parts.findIndex((part) => WEIGHT.test(part));
  if (weightAt >= 0) {
    const rest = parts.filter((_, i) => i !== weightAt).join(' ');
    if (perKg || BULK.includes(categoryOf(rest))) {
      const weight = WEIGHT.exec(parts[weightAt])!;
      const amount = toNumber(weight[1]);
      if (quantity === null) {
        quantity = weight[2].toLowerCase() === 'g' ? Math.round(amount) / 1000 : amount;
        unit = 'kg';
        parts.splice(weightAt, 1);
      }
    }
  } else if (perKg && quantity === null) {
    // "tomate 6,99/kg": a granel, sem o peso ainda (a balança diz depois).
    unit = 'kg';
  }

  // Um inteiro no começo, seguido de nome, é a quantidade ("12 ovos").
  if (quantity === null && unit === null && parts.length > 1 && INTEGER.test(parts[0])) {
    quantity = toNumber(parts[0]);
    parts.shift();
  }

  // Um inteiro sozinho no fim, depois do nome, também é a quantidade, nunca o preço ("pão 10", "leite 2 5,49").
  if (
    quantity === null &&
    unit === null &&
    parts.length > 1 &&
    INTEGER.test(parts[parts.length - 1])
  ) {
    quantity = toNumber(parts.pop()!);
  }

  const name = parts.join(' ').trim();
  if (!/\p{L}/u.test(name)) return null;
  const safeQuantity = quantity !== null && quantity > 0 && quantity <= MAX_QUANTITY ? quantity : 1;
  return {
    name: capitalize(name),
    quantity: safeQuantity,
    unit: unit !== null && (quantity === null || safeQuantity === quantity) ? unit : null,
    unitPrice: unitPrice !== null && unitPrice <= MAX_MONEY ? unitPrice : null,
    promo,
  };
}

/**
 * "Leve N pague M": o preço por unidade que sai de verdade (o da etiqueta vezes M, dividido por N), em centavos inteiros.
 * Devolve `null` para uma promoção que não faz sentido (pagar mais do que leva, ou zero).
 */
export function takePayPrice(sticker: number, take: number, pay: number): number | null {
  if (!(take > 0 && pay > 0 && pay < take) || !(sticker >= 0)) return null;
  return Math.round((sticker * pay * 100) / take) / 100;
}
