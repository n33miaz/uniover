import type { ProgressSet } from './series';

/** Peças de teste do domínio do progresso. Só os testes importam este arquivo; nada daqui entra no bundle do app. */

/** Fuso dos testes: Brasília (UTC-3, sem horário de verão desde 2019). */
export const SAO_PAULO = 'America/Sao_Paulo';

/** O instante de um dia e hora pelo relógio de Brasília: `at('2026-10-18', 9, 30)`. */
export function at(day: string, hour = 12, minute = 0): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date, hour + 3, minute);
}

/** Série de trabalho com valores razoáveis; o teste sobrescreve só o que importa. */
export function pset(overrides: Partial<ProgressSet> = {}): ProgressSet {
  return {
    sessionId: 's1',
    setType: 'work',
    weightKg: 40,
    reps: 10,
    completedAt: at('2026-10-10'),
    ...overrides,
  };
}

/** `count` séries iguais, uma por minuto a partir de `start`. */
export function repeated(
  count: number,
  overrides: Partial<ProgressSet> = {},
  start = at('2026-10-10'),
): ProgressSet[] {
  return Array.from({ length: count }, (_, index) =>
    pset({ ...overrides, completedAt: start + index * 60_000 }),
  );
}
