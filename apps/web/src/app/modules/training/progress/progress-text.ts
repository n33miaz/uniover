import type { ProgressPeriod } from '../domain/progress/calendar';
import { formatKg } from '../shell/format';

/** Textos e formatos da tela de Progresso (pt-BR), compartilhados pelas seções. Tudo texto de tela passa pelo i18n. */

const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' });
const monthAndYear = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const axisKg = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const shortMonthYear = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' });

/** O 1RM é estimativa: uma casa decimal ("53,8 kg"). */
export function formatOneRepMax(kg: number): string {
  return formatKg(Math.round(kg * 10) / 10);
}

/** Número do eixo de carga, sem unidade ("42,5"). */
export function formatAxisKg(value: number): string {
  return axisKg.format(value);
}

/** Marca do eixo do tempo quando a janela passa de dez meses ("out. de 25"). */
export function formatMonthYear(seconds: number): string {
  return shortMonthYear.format(seconds * 1000).replace('.', '');
}

/** `2026-10-12` vira `12/10`. */
export function dayMonthOfKey(key: string): string {
  const [, month, day] = key.split('-');
  return `${day}/${month}`;
}

/** A variação com sinal: "+10,5 kg", "−3 kg" (sinal de menos de verdade), "0 kg" quando não mudou. */
export function signedKg(deltaKg: number): string {
  const rounded = Math.round(Math.abs(deltaKg) * 10) / 10;
  if (rounded === 0) return formatKg(0);
  return `${deltaKg > 0 ? '+' : '−'}${formatKg(rounded)}`;
}

/** O nome do período, para o rótulo falado do gráfico. */
export function periodName(period: ProgressPeriod): string {
  switch (period) {
    case '8w':
      return $localize`:@@training.progress.period.name-8w:nas últimas 8 semanas`;
    case '6m':
      return $localize`:@@training.progress.period.name-6m:nos últimos 6 meses`;
    case 'all':
      return $localize`:@@training.progress.period.name-all:em todo o histórico`;
  }
}

function parts(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

const monthOf = (year: number, month: number) => monthName.format(Date.UTC(year, month - 1, 15));

/**
 * O intervalo de uma semana por extenso: "12 a 18 de outubro", e quando a semana cruza o mês ou o ano, o mês de cada ponta
 * ("28 de setembro a 4 de outubro"; "29 de dezembro de 2026 a 4 de janeiro de 2027"). Recebe as datas `AAAA-MM-DD` do
 * domingo e do sábado.
 */
export function weekLabel(startKey: string, endKey: string): string {
  const start = parts(startKey);
  const end = parts(endKey);
  const endMonth = monthOf(end.year, end.month);
  if (start.year === end.year && start.month === end.month) {
    return $localize`:@@training.progress.week.range-same-month:${start.day}:start: a ${end.day}:end: de ${endMonth}:month:`;
  }
  const startMonth = monthOf(start.year, start.month);
  if (start.year === end.year) {
    return $localize`:@@training.progress.week.range-two-months:${start.day}:start: de ${startMonth}:startMonth: a ${end.day}:end: de ${endMonth}:endMonth:`;
  }
  return $localize`:@@training.progress.week.range-two-years:${start.day}:start: de ${startMonth}:startMonth: de ${start.year}:startYear: a ${end.day}:end: de ${endMonth}:endMonth: de ${end.year}:endYear:`;
}

/** "Outubro de 2026". */
export function monthLabel(year: number, month: number): string {
  const text = monthAndYear.format(Date.UTC(year, month - 1, 15));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Só o mês, com a inicial maiúscula ("Outubro"). */
export function monthOnly(year: number, month: number): string {
  const text = monthOf(year, month);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
