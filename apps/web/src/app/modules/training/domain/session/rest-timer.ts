/**
 * Descanso entre séries, em funções puras. O timer guarda o **instante de fim**, nunca um contador: com a tela
 * bloqueada o JavaScript é suspenso, e o contador pararia; o instante de fim continua certo e o app recalcula ao voltar.
 */

/** Descanso padrão quando não há rotina (ou o exercício está fora dela). Proposta nossa. */
export const DEFAULT_REST_SECONDS = 90;

/** Quanto o botão "+15 s" soma. */
export const ADD_REST_MS = 15_000;

/** Descanso de uma série: o do item da rotina, ou o padrão sem rotina. */
export function restSecondsFor(item: { readonly restSeconds: number } | null | undefined): number {
  return item === null || item === undefined ? DEFAULT_REST_SECONDS : item.restSeconds;
}

/** Instante em que um descanso de `seconds` que começa em `now` termina. */
export function restEndsAt(now: number, seconds: number): number {
  return now + Math.max(0, seconds) * 1000;
}

/** Quanto falta (nunca negativo); sem timer, zero. */
export function remainingMs(endsAt: number | null, now: number): number {
  return endsAt === null ? 0 : Math.max(0, endsAt - now);
}

/** O descanso acabou: há timer e o instante de fim já passou. */
export function isOver(endsAt: number | null, now: number): boolean {
  return endsAt !== null && now >= endsAt;
}

/**
 * Soma tempo ao descanso. Se ele já tinha acabado, conta a partir de agora (o "+15 s" de um descanso vencido dá mais
 * 15 s, não um instante que já passou).
 */
export function extendRest(endsAt: number, now: number, ms: number = ADD_REST_MS): number {
  return Math.max(endsAt, now) + ms;
}
