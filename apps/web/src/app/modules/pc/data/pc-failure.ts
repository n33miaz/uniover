import { HttpErrorResponse } from '@angular/common/http';
import { isPermissionDenied, problemOf } from '../../../core/auth/api-problem';

export type PcFailureKind =
  | 'network'
  | 'session'
  | 'forbidden'
  | 'unavailable'
  | 'offline'
  | 'reconnecting'
  | 'timeout'
  | 'rate-limited'
  | 'failed'
  | 'locked'
  | 'elevated'
  | 'not-in-front'
  | 'device-pending'
  | 'device-denied'
  | 'device-unknown'
  | 'not-found'
  | 'invalid'
  | 'key-unsupported'
  | 'cancelled'
  | 'unknown';

/** `type` (sufixo) do 503 que a API dá quando o agente caiu agora há pouco e ainda está dentro da janela de reconexão. */
export const RECONNECTING_PROBLEM = 'agent-reconnecting';

/**
 * `type` (sufixo) do 409 que a API dá quando o toque precisa da `pc.key.v2` (tecla nova, repetição, segurar) e o agente
 * deste PC é de antes dela. Nada foi enviado: a pessoa precisa atualizar o agente.
 */
export const KEY_UNSUPPORTED_PROBLEM = 'pc-key-unsupported';

/**
 * O que um pedido devolve quando desistiu por conta própria (a conta mudou antes da vez dele): não é falha do PC, não tem
 * texto e nunca é mostrado. Quem recebe só precisa saber que nada foi enviado.
 */
export const CANCELLED: PcFailure = { kind: 'cancelled', message: '' };

export interface PcFailure {
  readonly kind: PcFailureKind;
  /** Texto curto, pronto para a tela, em pt-BR. */
  readonly message: string;
}

/**
 * `type` (sufixo) dos 403 que a API dá quando o dono do PC ainda não aprovou (ou recusou) este aparelho na tela do próprio PC. A conta tem a
 * permissão do módulo: o que falta é o aparelho ser permitido lá.
 */
export const DEVICE_PENDING_PROBLEM = 'pc-device-pending';
export const DEVICE_DENIED_PROBLEM = 'pc-device-denied';
/** O agente ainda não identificou o aparelho (a negociação com a API está em curso): tentar de novo resolve. */
export const DEVICE_UNKNOWN_PROBLEM = 'pc-device-unknown';

/**
 * Códigos do agente (`agentError`) para o `SendInput` que o Windows recusou: a tela de bloqueio (ou o desktop seguro) está na
 * frente, ou uma janela com mais privilégio (administrador, UAC) está em primeiro plano. O PC não está fora do ar nem lento:
 * a pessoa só precisa desbloquear ou tirar a janela.
 */
export const SESSION_LOCKED_CODE = 'session_locked';
export const ELEVATED_WINDOW_CODE = 'elevated_window';

/**
 * Código do agente para a tecla de um controle por programa que não saiu porque outro programa estava na frente (`target`). Quem
 * mostra troca o "programa" pelo nome do controle ("Abra o YouTube no PC e deixe-o na frente.").
 */
export const APP_NOT_IN_FRONT_CODE = 'app_not_in_front';

/** O PC está conectado, mas não responde: a API recusa na hora com o mesmo tipo do "reconectando" e a marca `stalled`. */
function isStalled(error: unknown): boolean {
  return (
    error instanceof HttpErrorResponse &&
    !!error.error &&
    typeof error.error === 'object' &&
    (error.error as { stalled?: unknown }).stalled === true
  );
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
    return {
      kind: 'unknown',
      message: $localize`:@@pc.error.unknown:Não deu certo. Tente de novo.`,
    };
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
  if (problem.status === 403 && problem.kind === DEVICE_PENDING_PROBLEM) {
    return {
      kind: 'device-pending',
      message: $localize`:@@pc.error.device-pending:Apareceu uma pergunta na tela do computador: clique em Sim para liberar este celular. Ela some em 2 minutos; para ela voltar, toque em Tentar de Novo (se não aparecer, espere 30 segundos e toque outra vez).`,
    };
  }
  if (problem.status === 403 && problem.kind === DEVICE_UNKNOWN_PROBLEM) {
    return {
      kind: 'device-unknown',
      message: $localize`:@@pc.error.device-unknown:O computador ainda está se preparando para reconhecer este celular. Toque em Tentar de Novo.`,
    };
  }
  if (problem.status === 403 && problem.kind === DEVICE_DENIED_PROBLEM) {
    return {
      kind: 'device-denied',
      message: $localize`:@@pc.error.device-denied:Alguém respondeu Não à pergunta no computador, e este celular ficou bloqueado por uma hora. Depois disso, use o controle de novo para a pergunta reaparecer.`,
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
    return {
      kind: 'invalid',
      message: $localize`:@@pc.error.invalid:O PC não aceitou este pedido.`,
    };
  }
  if (problem.status === 404) {
    return {
      kind: 'not-found',
      message: $localize`:@@pc.error.not-found:Esse atalho não existe mais neste PC.`,
    };
  }
  if (problem.status === 409 && problem.kind === KEY_UNSUPPORTED_PROBLEM) {
    return {
      kind: 'key-unsupported',
      message: $localize`:@@pc.error.key-unsupported:Este computador precisa de uma atualização para fazer isso.`,
    };
  }
  if (problem.status === 409) {
    return {
      kind: 'unavailable',
      message: $localize`:@@pc.error.unavailable:Nenhum PC com o controle ligado.`,
    };
  }
  if (problem.status === 503 && problem.kind === RECONNECTING_PROBLEM) {
    return {
      kind: 'reconnecting',
      message: isStalled(error)
        ? $localize`:@@pc.error.stalled:O PC está lento e não respondeu.`
        : $localize`:@@pc.error.reconnecting:O PC está reconectando.`,
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
  if (code === SESSION_LOCKED_CODE) {
    return {
      kind: 'locked',
      message: $localize`:@@pc.error.locked:O PC está bloqueado.`,
    };
  }
  if (code === APP_NOT_IN_FRONT_CODE) {
    return {
      kind: 'not-in-front',
      message: $localize`:@@pc.error.not-in-front:Abra o programa no PC e deixe-o na frente.`,
    };
  }
  if (code === ELEVATED_WINDOW_CODE) {
    return {
      kind: 'elevated',
      message: $localize`:@@pc.error.elevated:Há uma janela de administrador na frente.`,
    };
  }
  return {
    kind: 'failed',
    message:
      code === 'unknown_app'
        ? $localize`:@@pc.error.unknown-app:Esse atalho não existe mais neste PC.`
        : $localize`:@@pc.error.failed:O PC não executou o comando.`,
  };
}
