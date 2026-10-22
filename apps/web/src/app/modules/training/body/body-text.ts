import { dayMonthOfKey, signedKg } from '../progress/progress-text';

/**
 * Formatos e leitura de números da tela Corpo (pt-BR). Tudo o que aparece como número de saúde passa por aqui: uma casa
 * decimal para peso, gordura e medidas, inteiro para quilocalorias (o mesmo arredondamento do domínio).
 */

const NBSP = ' ';

const oneDecimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const factorFormat = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const megabytes = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const fullDate = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "82,4 kg". O espaço não quebra: o número nunca se separa da unidade. */
export const formatWeight = (kg: number): string => `${oneDecimal.format(kg)}${NBSP}kg`;

/** "16,9 %". */
export const formatPercent = (value: number): string => `${oneDecimal.format(value)}${NBSP}%`;

/** "86,0 cm". */
export const formatCm = (value: number): string => `${oneDecimal.format(value)}${NBSP}cm`;

/** "2.400 kcal". */
export const formatKcal = (value: number): string => `${integer.format(value)}${NBSP}kcal`;

/** Só o número de quilocalorias ("2.400"). */
export const formatKcalNumber = (value: number): string => integer.format(value);

/** O fator de atividade ("1,55"; "1,375"). */
export const formatFactor = (value: number): string => factorFormat.format(value);

/** Número com uma casa para o campo de texto ("82,4"), com vírgula. */
export const toFieldText = (value: number): string => oneDecimal.format(value);

/** `2026-10-18` vira `18/10`. */
export const dayMonth = dayMonthOfKey;

/** `2026-10-18` vira `18/10/2026`. */
export function formatFullDate(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return fullDate.format(date);
}

/** A variação com sinal em uma casa ("−0,7 kg"). */
export const signedWeight = signedKg;

/** Bytes em "MB"/"GB" legíveis ("2,4 MB", "1,2 GB"); abaixo de 1 MB mostra em KB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024)
    return `${integer.format(Math.max(1, Math.round(bytes / 1024)))}${NBSP}KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${megabytes.format(bytes / (1024 * 1024))}${NBSP}MB`;
  }
  return `${megabytes.format(bytes / (1024 * 1024 * 1024))}${NBSP}GB`;
}

/**
 * Lê um número digitado: vírgula ou ponto como separador decimal. Texto vazio, com letras ou com mais de um separador volta
 * `null` (a tela diz "digite um número"). Não aceita separador de milhar: peso e medida não passam de três dígitos.
 */
export function parseDecimal(text: string): number | null {
  const clean = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}
