import { HttpErrorResponse } from '@angular/common/http';

/** Campos do `ProblemDetails` (RFC 9457) que o app lê; o resto da resposta é ignorado. */
interface ProblemBody {
  readonly type?: unknown;
  readonly title?: unknown;
  readonly code?: unknown;
  readonly action?: unknown;
  readonly errors?: unknown;
}

/** Sufixo do `type` que a API devolve quando a ação perigosa precisa de confirmação com a passkey. */
export const STEP_UP_PROBLEM = 'step-up-required';
/** Valor da extensão `code` do mesmo erro. */
export const STEP_UP_CODE = 'step_up_required';

/**
 * Erro de uma chamada à API. `status` 0 significa "sem resposta" (rede caiu, servidor dormindo, bloqueio).
 * `kind` é o último trecho do `type` (a API manda uma URL estável, por exemplo `.../problems/login-locked`).
 */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    title: string,
    readonly code: string | null = null,
    readonly action: string | null = null,
    readonly retryAfterSeconds: number | null = null,
    readonly fieldErrors: Readonly<Record<string, readonly string[]>> = {},
  ) {
    super(title);
    this.name = 'ApiProblem';
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function networkProblem(): ApiProblem {
  return new ApiProblem(0, 'network', 'Sem resposta do servidor.');
}

/** Pedido recusado por falta de confirmação com a passkey (e não por senha errada ou desafio vencido, que também são 403). */
export function isStepUpRequired(problem: ApiProblem): boolean {
  return (
    problem.status === 403 && (problem.kind === STEP_UP_PROBLEM || problem.code === STEP_UP_CODE)
  );
}

/** `type` (sufixo) que a API dá ao 403 de uma política de acesso: o papel ou a permissão que a rota exige a conta não tem. */
export const FORBIDDEN_PROBLEM = 'forbidden';

/**
 * Recusa por falta de acesso (papel ou permissão): o 403 sem tipo próprio da API. Fica de fora tudo o que também é 403
 * mas tem tipo específico e nada a ver com o que a conta pode usar: confirmação com a passkey (pedida ou recusada), senha
 * errada, exercício do catálogo, pareamento recusado.
 */
export function isPermissionDenied(problem: ApiProblem): boolean {
  return problem.status === 403 && problem.kind === FORBIDDEN_PROBLEM && !isStepUpRequired(problem);
}

/** `type` (sufixo) do 401 que a API dá quando o dono pausou a conta do convidado. */
export const GUEST_PAUSED_PROBLEM = 'guest-paused';

/** Entrada ou renovação recusada porque o dono pausou o acesso: o app mostra só "Acesso Pausado", sem mais detalhe. */
export function isGuestPaused(problem: ApiProblem): boolean {
  return problem.status === 401 && problem.kind === GUEST_PAUSED_PROBLEM;
}

/** `Retry-After` em segundos inteiros ou em data HTTP; devolve segundos (mínimo 1) ou `null` se ausente/ilegível. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(1, Math.ceil((date - nowMs) / 1000));
}

function lastSegment(type: unknown): string {
  if (typeof type !== 'string') return '';
  const end = type.split(/[?#]/)[0].replace(/\/+$/, '');
  return end.slice(end.lastIndexOf('/') + 1);
}

function fieldErrorsOf(value: unknown): Record<string, readonly string[]> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, readonly string[]> = {};
  for (const [field, messages] of Object.entries(value)) {
    if (Array.isArray(messages)) result[field] = messages.filter((m) => typeof m === 'string');
  }
  return result;
}

/** Monta o erro a partir do status, do corpo já lido (qualquer coisa) e do cabeçalho `Retry-After`. */
export function problemFrom(
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
): ApiProblem {
  const data: ProblemBody = body && typeof body === 'object' ? (body as ProblemBody) : {};
  return new ApiProblem(
    status,
    lastSegment(data.type),
    typeof data.title === 'string' ? data.title : `HTTP ${status}`,
    typeof data.code === 'string' ? data.code : null,
    typeof data.action === 'string' ? data.action : null,
    parseRetryAfter(retryAfterHeader),
    fieldErrorsOf(data.errors),
  );
}

/** Lê qualquer erro de chamada (do cliente de identidade ou do `HttpClient`) como `ApiProblem`; `null` se não for de HTTP. */
export function problemOf(error: unknown): ApiProblem | null {
  if (error instanceof ApiProblem) return error;
  if (error instanceof HttpErrorResponse) {
    return error.status === 0
      ? networkProblem()
      : problemFrom(error.status, error.error, error.headers.get('Retry-After'));
  }
  return null;
}
