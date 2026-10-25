import { HttpErrorResponse } from '@angular/common/http';
import { problemOf } from '../../../core/auth/api-problem';

export type TvFailureKind =
  | 'network'
  | 'session'
  | 'forbidden'
  | 'agent-offline'
  | 'not-configured'
  | 'timeout'
  | 'command-failed'
  | 'rate-limited'
  | 'cleanup-busy'
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

/** Códigos do canal ADB do agente: a TV não atendeu pelo ADB (desligada, fora da rede ou sem responder a tempo). */
const ADB_UNREACHABLE_CODES = new Set(['adb_unreachable', 'adb_unavailable', 'adb_timeout']);

/**
 * Códigos do desligamento com leitura (o agente devolve em minúsculas). Só valem nesse pedido: `offline` e `failed` são
 * palavras comuns demais para valerem em qualquer comando.
 */
function powerOffFailedMessage(code: string | null): string | null {
  switch (code) {
    case 'uncertain':
      return $localize`:@@tv.error.power-off-uncertain:Não deu para confirmar se a TV desligou, e a tecla não foi repetida. Olhe a TV antes de tentar de novo.`;
    case 'offline':
      return $localize`:@@tv.error.power-off-offline:A TV não respondeu ao controle e nada foi enviado. Ela pode já estar desligada.`;
    case 'failed':
      return $localize`:@@tv.error.power-off-failed:O agente não conseguiu desligar a TV. Olhe a TV antes de tentar de novo.`;
    default:
      return null;
  }
}

function commandFailedMessage(code: string | null, context?: TvFailureContext): string {
  const powerOff = context === 'power-off' ? powerOffFailedMessage(code) : null;
  if (powerOff) return powerOff;
  if (code === 'TV_UNREACHABLE') {
    return $localize`:@@tv.error.tv-unreachable:A TV não respondeu ao controle. Confira se ela está ligada e na rede.`;
  }
  if (code !== null && ADB_UNREACHABLE_CODES.has(code)) {
    return $localize`:@@tv.error.adb-unreachable:A TV não respondeu pelo ADB agora. Tente de novo com a TV ligada.`;
  }
  if (code === 'adb_unauthorized') {
    return $localize`:@@tv.error.adb-unauthorized:A TV ainda não autorizou o computador do agente no ADB. Aceite o aviso na tela da TV e tente de novo.`;
  }
  if (code === 'cleanup_report_missing') {
    return $localize`:@@tv.error.cleanup-report-missing:A TV recebeu o pedido, mas não deu para confirmar o que foi limpo. Confira a TV.`;
  }
  return code
    ? $localize`:@@tv.error.command-failed-code:A TV não executou o comando (código ${code}:code:).`
    : $localize`:@@tv.error.command-failed:A TV não executou o comando.`;
}

/**
 * A conta não tem a permissão do que foi pedido. A tela já não oferece o que a pessoa não pode, então isto só chega
 * quando o administrador tirou a permissão há pouco (a tela ainda não soube) ou por um atalho antigo.
 */
export function forbiddenMessage(): string {
  return $localize`:@@tv.error.forbidden:Você não tem permissão para fazer isso na TV.`;
}

/**
 * O que se estava fazendo: a limpeza leva até ~25 s, e o desligamento com leitura espera a TV confirmar, então "tempo
 * esgotado" não quer dizer "não aconteceu".
 */
export type TvFailureContext = 'cleanup' | 'power-off';

/** Traduz a falha de uma chamada do controle na mensagem da tela; nenhuma delas é repetida sozinha. */
export function describeFailure(error: unknown, context?: TvFailureContext): TvFailure {
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
    case 403:
      return make('forbidden', forbiddenMessage());
    case 404:
      return make(
        'not-found',
        $localize`:@@tv.error.not-found:Este atalho não existe mais. Atualize a lista.`,
      );
    case 409:
      return problem.kind === 'cleanup-in-progress'
        ? make(
            'cleanup-busy',
            $localize`:@@tv.error.cleanup-busy:Já há uma limpeza da TV em andamento. Aguarde ela terminar.`,
          )
        : make(
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
      return make('command-failed', commandFailedMessage(agentErrorOf(error), context));
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
        context === 'cleanup'
          ? $localize`:@@tv.error.cleanup-timeout:A limpeza demorou mais do que o esperado e a TV pode ter terminado. Confira a TV e tente de novo.`
          : context === 'power-off'
            ? $localize`:@@tv.error.power-off-timeout:O desligamento demorou mais do que o esperado e a TV pode ter desligado. Olhe a TV antes de tentar de novo.`
            : $localize`:@@tv.error.timeout:A TV não respondeu a tempo. Tente de novo.`,
      );
    default:
      return make('unknown', $localize`:@@tv.error.unknown:Não foi possível falar com a TV agora.`);
  }
}
