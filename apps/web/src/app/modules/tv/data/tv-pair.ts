import { HttpErrorResponse } from '@angular/common/http';
import { problemOf } from '../../../core/auth/api-problem';

/**
 * Por que o pareamento pelo app não andou:
 * - `unreachable`: a TV (ou o computador dela) não respondeu;
 * - `unsupported`: o computador da TV é antigo demais para parear pelo app;
 * - `code`: o código não serviu (a TV recusou, venceu ou o pareamento já tinha acabado): é preciso pedir outro;
 * - `forbidden`: só o dono pareia;
 * - `wait`: pediu outro código cedo demais (a API espera alguns segundos entre dois pedidos);
 * - `failed`: qualquer outra falha.
 */
export type TvPairFailure =
  'unreachable' | 'unsupported' | 'code' | 'forbidden' | 'wait' | 'failed';

/** Códigos que o agente devolve quando o código digitado não serve mais. */
const CODE_FAILURES = new Set(['invalid_code', 'pair_closed', 'pair_timeout', 'pair_not_started']);

/** O código que a Android TV mostra: 6 caracteres hexadecimais (0-9 e A-F). */
const CODE_PATTERN = /^[0-9A-F]{6}$/;

/** Deixa só o que cabe num código (hexadecimal, maiúsculo, até 6): o que a pessoa digita ou cola é limpo na hora. */
export function cleanPairCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
    .slice(0, 6);
}

export function isPairCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

function agentErrorOf(error: unknown): string | null {
  if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
    const code = (error.error as { agentError?: unknown }).agentError;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }
  return null;
}

/** Traduz a resposta de erro da API (e o código do agente, quando vem) no que a folha de pareamento mostra. */
export function pairFailureOf(error: unknown): TvPairFailure {
  const problem = problemOf(error);
  if (problem?.kind === 'pair-unsupported') return 'unsupported';
  if (problem?.status === 403) return 'forbidden';
  if (problem?.status === 429) return 'wait';
  if (problem?.kind === 'agent-offline' || problem?.kind === 'agent-timeout') return 'unreachable';
  const agentError = agentErrorOf(error);
  if (agentError === 'tv_unreachable') return 'unreachable';
  if (agentError !== null && CODE_FAILURES.has(agentError)) return 'code';
  return 'failed';
}
