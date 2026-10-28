/** O maior intervalo de ausência aceito de uma vez (um ano); evita gravar milhares de dias por um erro de digitação. */
const MAX_ABSENCE_DAYS = 366;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Os dias civis (AAAA-MM-DD) de `from` até `to`, inclusive. Vazio quando uma ponta não é data, quando o fim vem antes do
 * começo ou quando o intervalo passa de um ano. A conta é em UTC ao meio-dia: nenhum horário de verão desloca o dia.
 */
export function absenceDays(from: string, to: string): string[] {
  if (!DAY_KEY.test(from) || !DAY_KEY.test(to) || from > to) return [];
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return [];
  const days: string[] = [];
  while (cursor <= end) {
    if (days.length >= MAX_ABSENCE_DAYS) return [];
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
