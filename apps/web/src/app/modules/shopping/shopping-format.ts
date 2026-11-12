const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const DAY = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
const DAY_YEAR = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatMoney(value: number): string {
  return MONEY.format(value);
}

/** "12 de nov." (o ano só aparece quando não é o atual). */
export function formatDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  return (date.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(date);
}

/** "2", "1,5 kg": a vírgula do português e a unidade, quando há. */
export function formatQuantity(value: number, unit?: string | null): string {
  const amount = String(Math.round(value * 1000) / 1000).replace('.', ',');
  return unit ? `${amount} ${unit}` : amount;
}

/** O valor para pôr de volta num campo: "5,49", ou vazio. */
export function moneyField(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : value.toFixed(2).replace('.', ',');
}
