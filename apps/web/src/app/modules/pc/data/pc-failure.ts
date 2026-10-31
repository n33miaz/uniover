import { HttpErrorResponse } from '@angular/common/http';
import { isPermissionDenied, problemOf } from '../../../core/auth/api-problem';

export type PcFailureKind =
  | 'network'
  | 'session'
  | 'forbidden'
  | 'unavailable'
  | 'offline'
  | 'timeout'
  | 'rate-limited'
  | 'failed'
  | 'not-found'
  | 'invalid'
  | 'unknown';

export interface PcFailure {
  readonly kind: PcFailureKind;
  /** Texto curto, pronto para a tela, em pt-BR. */
  readonly message: string;
}

/** O código do agente (`failed`, `unknown_app`...) vem numa extensão do problema que o leitor comum do app descarta. */
function agentErrorOf(error: unknown): string | null {
  if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
    const code = (error.error as { agentError?: unknown }).agentError;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }
  return null;
}

/** Traduz qualquer erro de uma chamada do controle do PC numa falha com texto curto para a tela. */
export function pcFailureOf(error: unknown): PcFailure {
  const problem = problemOf(error);
  if (!problem) {
    return { kind: 'unknown', message: $localize`:@@pc.error.unknown:Algo deu errado.` };
  }
  if (problem.isNetwork) {
    return {
      kind: 'network',
      message: $localize`:@@pc.error.network:Sem conexão com o servidor.`,
    };
  }
  if (problem.status === 401) {
    return {
      kind: 'session',
      message: $localize`:@@pc.error.session:Sua sessão expirou. Entre de novo.`,
    };
  }
  if (isPermissionDenied(problem)) {
    return {
      kind: 'forbidden',
      message: $localize`:@@pc.error.forbidden:Esta conta não pode controlar o PC.`,
    };
  }
  if (problem.status === 429) {
    return {
      kind: 'rate-limited',
      message: $localize`:@@pc.error.rate-limited:Muitos comandos seguidos. Espere um instante.`,
    };
  }
  if (problem.status === 400) {
    return { kind: 'invalid', message: $localize`:@@pc.error.invalid:Pedido inválido.` };
  }
  if (problem.status === 404) {
    return {
      kind: 'not-found',
      message: $localize`:@@pc.error.not-found:Esse atalho não existe mais neste PC.`,
    };
  }
  if (problem.status === 409) {
    return {
      kind: 'unavailable',
      message: $localize`:@@pc.error.unavailable:Nenhum PC com o controle ligado.`,
    };
  }
  if (problem.status === 503) {
    return {
      kind: 'offline',
      message: $localize`:@@pc.error.offline:O PC está desconectado.`,
    };
  }
  if (problem.status === 504) {
    return {
      kind: 'timeout',
      message: $localize`:@@pc.error.timeout:O PC não respondeu a tempo.`,
    };
  }
  const code = agentErrorOf(error);
  return {
    kind: 'failed',
    message:
      code === 'unknown_app'
        ? $localize`:@@pc.error.unknown-app:Esse atalho não existe mais neste PC.`
        : $localize`:@@pc.error.failed:O PC não executou o comando.`,
  };
}
