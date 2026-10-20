import { HttpErrorResponse } from '@angular/common/http';
import { problemOf } from '../../../core/auth/api-problem';

export type TvFailureKind =
  | 'network'
  | 'session'
  | 'agent-offline'
  | 'not-configured'
  | 'timeout'
  | 'command-failed'
  | 'rate-limited'
  | 'shortcut-disabled'
  | 'not-found'
  | 'invalid'
  | 'unknown';

export interface TvFailure {
  readonly kind: TvFailureKind;
  /** Texto pronto para a tela, em pt-BR. */
  readonly message: string;
  readonly retryAfterSeconds: number | null;
}

/** O código do agente (ex.: `TV_UNREACHABLE`) vem numa extensão do problema que o leitor comum do app descarta. */
function agentErrorOf(error: unknown): string | null {
  if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
    const code = (error.error as { agentError?: unknown }).agentError;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }
  return null;
}

function commandFailedMessage(code: string | null): string {
  if (code === 'TV_UNREACHABLE') {
    return $localize`:@@tv.error.tv-unreachable:A TV não respondeu ao controle. Confira se ela está ligada e na rede.`;
  }
  return code
    ? $localize`:@@tv.error.command-failed-code:A TV não executou o comando (código ${code}:code:).`
    : $localize`:@@tv.error.command-failed:A TV não executou o comando.`;
}

/** Traduz a falha de uma chamada do controle na mensagem da tela; nenhuma delas é repetida sozinha. */
export function describeFailure(error: unknown): TvFailure {
  const problem = problemOf(error);
  if (!problem) {
    return {
      kind: 'unknown',
      message: $localize`:@@tv.error.unknown:Não foi possível falar com a TV agora.`,
      retryAfterSeconds: null,
    };
  }

  const make = (kind: TvFailureKind, message: string, retry: number | null = null): TvFailure => ({
    kind,
    message,
    retryAfterSeconds: retry,
  });

  if (problem.isNetwork) {
    return make(
      'network',
      $localize`:@@tv.error.network:Sem conexão com o servidor. Confira a internet.`,
    );
  }

  switch (problem.status) {
    case 400:
      return make(
        'invalid',
        $localize`:@@tv.error.invalid:A TV não aceitou o pedido. Confira o que foi digitado.`,
      );
    case 401:
      return make(
        'session',
        $localize`:@@tv.error.session:Sua sessão acabou. Entre de novo para controlar a TV.`,
      );
    case 404:
      return make(
        'not-found',
        $localize`:@@tv.error.not-found:Este atalho não existe mais. Atualize a lista.`,
      );
    case 409:
      return make(
        'shortcut-disabled',
        $localize`:@@tv.error.shortcut-disabled:Este app não está mais instalado na TV. Atualize a lista.`,
      );
    case 429: {
      const seconds = problem.retryAfterSeconds;
      return make(
        'rate-limited',
        seconds
          ? $localize`:@@tv.error.rate-limited-seconds:Comandos demais em pouco tempo. Aguarde ${seconds}:seconds: s.`
          : $localize`:@@tv.error.rate-limited:Comandos demais em pouco tempo. Aguarde um pouco.`,
        seconds,
      );
    }
    case 502:
      return make('command-failed', commandFailedMessage(agentErrorOf(error)));
    case 503:
      return problem.kind === 'agent-not-configured'
        ? make(
            'not-configured',
            $localize`:@@tv.error.not-configured:Nenhum agente foi configurado para controlar a TV.`,
          )
        : make(
            'agent-offline',
            $localize`:@@tv.error.agent-offline:O agente da TV está desligado. Ligue o computador que controla a TV.`,
          );
    case 504:
      return make(
        'timeout',
        $localize`:@@tv.error.timeout:A TV não respondeu a tempo. Tente de novo.`,
      );
    default:
      return make('unknown', $localize`:@@tv.error.unknown:Não foi possível falar com a TV agora.`);
  }
}
