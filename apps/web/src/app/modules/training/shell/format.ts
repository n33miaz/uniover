/** Formatação de números e datas do Treino (pt-BR), compartilhada pelas telas. */

const kgFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

/** "42,5 kg"; inteiro sem casas ("40 kg"). */
export function formatKg(value: number): string {
  return `${kgFormat.format(value)} kg`;
}

/** A data de um instante como "18/10", no fuso do aparelho. */
export function formatDayMonth(timestamp: number): string {
  return dayFormat.format(timestamp);
}

/** "1 min 30 s" para uma duração em segundos (série de tipo tempo). */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
