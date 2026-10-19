/** O que voltou de uma tentativa de envio. */
export type SendOutcome =
  | {
      /** Rede caiu, `fetch` rejeitado ou tempo esgotado: não houve resposta. */
      readonly kind: 'network-error';
    }
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Cabeçalhos da resposta, com nomes em minúsculas. */
      readonly headers: Readonly<Record<string, string>>;
      /** Final do `type` do problema (`idempotency-in-progress`), se a resposta trouxe um ProblemDetails. */
      readonly problemType?: string;
    };

/** O que o motor faz com o item depois da tentativa. */
export type Decision =
  /** Servidor aceitou (2xx), inclusive resposta reaproveitada do reenvio. */
  | { readonly action: 'done'; readonly replayed: boolean }
  /** Tentar de novo depois de `delayMs`; não conta como falha definitiva. */
  | { readonly action: 'retry'; readonly delayMs: number; readonly reason: string }
  /** 401: manter na fila e esperar sessão; nunca descartar. */
  | { readonly action: 'auth' }
  /** Recusa de negócio: o item fica `failed`, visível, e os demais seguem. */
  | { readonly action: 'failed'; readonly reason: string };

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** Espera antes de repetir quando o servidor diz que a mesma chave ainda está em andamento. */
export const IN_PROGRESS_RETRY_MS = 3_000;
/** Teto para o `Retry-After` do servidor (uma hora é o bastante para qualquer limite razoável). */
export const RETRY_AFTER_MAX_MS = 60 * 60_000;

/**
 * Espera antes da próxima tentativa: `min(2 s × 2^n, 5 min)` com jitter de ±20% (sem passar do teto).
 * `failures` é quantas tentativas já falharam (1 depois da primeira falha).
 */
export function backoffDelayMs(failures: number, random: number): number {
  const exponent = Math.max(0, failures - 1);
  const base = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
  const jittered = base * (0.8 + 0.4 * random);
  return Math.min(Math.round(jittered), BACKOFF_MAX_MS);
}

/** `Retry-After` em segundos ou data HTTP, em milissegundos; `null` se ausente ou ilegível. */
export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1_000, RETRY_AFTER_MAX_MS);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - nowMs, 0), RETRY_AFTER_MAX_MS);
}

/**
 * Classificação única do resultado de um envio (função pura). Regras:
 * - rede, tempo esgotado, 408 e 5xx (inclusive 502/503 do Render acordando) → tentar de novo com backoff;
 * - 429 → respeita `Retry-After`; 409 `idempotency-in-progress` → tentar de novo em poucos segundos;
 * - 401 → fica na fila esperando sessão; **nada** é descartado por 401;
 * - qualquer outro 4xx (400, 404, 422, 409 de negócio...) → falha definitiva do item, que não trava os demais.
 */
export function classifyResult(
  outcome: SendOutcome,
  context: { readonly failures: number; readonly nowMs: number; readonly random: number },
): Decision {
  const backoff = () => backoffDelayMs(context.failures, context.random);

  if (outcome.kind === 'network-error') {
    return { action: 'retry', delayMs: backoff(), reason: 'network' };
  }

  const { status, headers } = outcome;
  if (status >= 200 && status < 300) {
    return { action: 'done', replayed: headers['idempotent-replayed'] === 'true' };
  }
  if (status === 401) return { action: 'auth' };
  if (status === 429) {
    const retryAfter = parseRetryAfterMs(headers['retry-after'], context.nowMs);
    return {
      action: 'retry',
      delayMs: retryAfter === null ? backoff() : Math.max(retryAfter, 1_000),
      reason: 'rate-limited',
    };
  }
  if (status === 409 && outcome.problemType === 'idempotency-in-progress') {
    return { action: 'retry', delayMs: IN_PROGRESS_RETRY_MS, reason: 'idempotency-in-progress' };
  }
  if ((status === 502 || status === 503) && 'x-render-routing' in headers) {
    return { action: 'retry', delayMs: backoff(), reason: 'server-waking' };
  }
  if (status === 408 || status >= 500) {
    return { action: 'retry', delayMs: backoff(), reason: `http-${status}` };
  }
  const detail = outcome.problemType ? `${status}:${outcome.problemType}` : String(status);
  return { action: 'failed', reason: `http-${detail}` };
}
