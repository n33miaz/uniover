/** O que o resumo de um programa precisa de uma ficha do modelo. */
export interface SummaryRoutine {
  readonly name: string;
  readonly weekdays: readonly number[];
}

/** Programas que o app oferece como "programa da semana": os modelos que declaram os dias (o histórico não). */
export function isProgramTemplate(template: {
  readonly id: string;
  readonly routines: readonly SummaryRoutine[];
}): boolean {
  return (
    template.id !== 'historical-ab' &&
    template.routines.length > 0 &&
    template.routines.every((routine) => routine.weekdays.length > 0)
  );
}

function dayName(day: number): string {
  switch (day) {
    case 1:
      return $localize`:@@training.program.day-1:Seg`;
    case 2:
      return $localize`:@@training.program.day-2:Ter`;
    case 3:
      return $localize`:@@training.program.day-3:Qua`;
    case 4:
      return $localize`:@@training.program.day-4:Qui`;
    case 5:
      return $localize`:@@training.program.day-5:Sex`;
    case 6:
      return $localize`:@@training.program.day-6:Sáb`;
    default:
      return $localize`:@@training.program.day-7:Dom`;
  }
}

/** "Seg–sex" para dias seguidos (três ou mais), "Seg, qua, sex" nos outros casos. */
export function daysText(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const consecutive = sorted.every((day, index) => index === 0 || day === sorted[index - 1] + 1);
  if (sorted.length >= 3 && consecutive) {
    return `${dayName(sorted[0])}–${dayName(sorted[sorted.length - 1]).toLowerCase()}`;
  }
  return sorted
    .map((day, index) => (index === 0 ? dayName(day) : dayName(day).toLowerCase()))
    .join(', ');
}

/** O nome da ficha sem o prefixo do dia ("Segunda · Peito" vira "Peito") e sem o parêntese final. */
function label(name: string): string {
  const afterDot = name.includes('·') ? name.slice(name.indexOf('·') + 1) : name;
  return afterDot.replace(/\s*\(.*\)\s*$/, '').trim();
}

/**
 * Resumo curto dos dias de um programa para a escolha. Uma ficha por dia: "Seg Peito, ombros e tríceps · Ter Costas e
 * bíceps · ...". Fichas que dividem os mesmos dias (A/B nos dias de treino): "Seg–sex alterna Empurrar / Puxar".
 */
export function programSummary(routines: readonly SummaryRoutine[]): string {
  const single = routines.every((routine) => routine.weekdays.length === 1);
  const shared =
    routines.length > 1 && new Set(routines.map((r) => r.weekdays.join(','))).size === 1;
  if (!single && shared) {
    const days = daysText(routines[0].weekdays);
    const names = [...new Set(routines.map((routine) => label(routine.name)))].join(' / ');
    return routines.length > 1 && names.includes(' / ')
      ? $localize`:@@training.program.alternates:${days}:days: alterna ${names}:names:`
      : `${days} ${names}`;
  }
  return [...routines]
    .sort((a, b) => a.weekdays[0] - b.weekdays[0])
    .map((routine) => `${daysText(routine.weekdays)} ${label(routine.name)}`)
    .join(' · ');
}
