import { HttpClient, HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { catchError, firstValueFrom, map, of, timeout } from 'rxjs';
import { AUTH_CONFIG, AuthService } from '../auth/auth.service';
import { SessionState } from '../session/session-state';
import { SendOutcome } from './classify-result';
import { OutboxMethod } from './offline-db';

export interface QueueRequest {
  /** A conta dona do item: a escrita só pode sair com o token DESSA conta (ver `HttpClientQueueTransport`). */
  readonly accountId: string;
  readonly method: OutboxMethod;
  readonly url: string;
  readonly body: unknown;
  /** Sempre traz `Idempotency-Key` e `Content-Type`. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Porta de saída da fila. O adaptador padrão usa o `HttpClient` do app (então o interceptador de conexão vale para a fila,
 * e o de autenticação só deixa passar: o token é posto aqui); o teste injeta um transporte falso.
 */
export interface QueueTransport {
  send(request: QueueRequest): Promise<SendOutcome>;
}

/** Quanto esperar uma resposta antes de dar a tentativa por perdida e voltar ao backoff. */
export const SEND_TIMEOUT_MS = 60_000;

/** Nada foi enviado porque não há token desta conta: o motor trata como um 401 (espera e confere de novo). */
const UNAUTHENTICATED: SendOutcome = { kind: 'response', status: 401, headers: {} };

function problemTypeOf(body: unknown): string | undefined {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return undefined;
  return type.slice(type.lastIndexOf('/') + 1) || undefined;
}

function headersOf(headers: HttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of headers.keys()) {
    const value = headers.get(name);
    if (value !== null) out[name.toLowerCase()] = value;
  }
  return out;
}

/**
 * O transporte padrão. Uma escrita da conta A NUNCA sai com o token de outra conta, qualquer que seja o cookie do navegador
 * naquele instante (outra pessoa pode ter entrado noutra aba): por isso o `Authorization` é montado aqui, com um token cujo
 * `sub` é a conta da fila, e o interceptador de autenticação (que renovaria e repetiria o pedido por baixo, com o cookie
 * que houver) só o deixa passar. O token é lido e usado no mesmo instante, sem nada assíncrono no meio.
 *
 * Sem um token desta conta, ou com a resposta 401, o resultado é "não autenticado": o motor guarda o item, espera e confere de
 * novo na próxima passada. Um 401 também pede uma renovação, e o motor tenta de novo quando o token novo chegar.
 */
export class HttpClientQueueTransport implements QueueTransport {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);
  private readonly minLeadMs = inject(AUTH_CONFIG).minLeadMs;

  async send(request: QueueRequest): Promise<SendOutcome> {
    let token = this.session.bearerOf(request.accountId, Date.now() + this.minLeadMs);
    if (token === null) {
      // Falta pouco (ou nada) do token: a renovação é do `AuthService`, mas o que vale é o token que ele deixou na sessão, e
      // só se for desta conta.
      await this.auth.accessToken();
      token = this.session.bearerOf(request.accountId);
    }
    if (token === null) return UNAUTHENTICATED;
    const outcome = await this.post(request, token);
    if (outcome.kind === 'response' && outcome.status === 401) void this.auth.renew();
    return outcome;
  }

  private post(request: QueueRequest, token: string): Promise<SendOutcome> {
    return firstValueFrom(
      this.http
        .request(request.method, request.url, {
          body: request.body === undefined ? null : JSON.stringify(request.body),
          headers: new HttpHeaders({ ...request.headers, Authorization: `Bearer ${token}` }),
          observe: 'response',
          responseType: 'text',
        })
        .pipe(
          timeout({ first: SEND_TIMEOUT_MS }),
          map((response: HttpResponse<string>): SendOutcome => ({
            kind: 'response',
            status: response.status,
            headers: headersOf(response.headers),
          })),
          catchError((error: unknown) => {
            if (error instanceof HttpErrorResponse && error.status !== 0) {
              const problemType = problemTypeOf(error.error);
              return of<SendOutcome>({
                kind: 'response',
                status: error.status,
                headers: headersOf(error.headers),
                ...(problemType ? { problemType } : {}),
              });
            }
            // status 0, tempo esgotado ou qualquer coisa sem resposta: a rede não entregou.
            return of<SendOutcome>({ kind: 'network-error' });
          }),
        ),
    );
  }
}

export const QUEUE_TRANSPORT = new InjectionToken<QueueTransport>('QUEUE_TRANSPORT', {
  providedIn: 'root',
  factory: () => new HttpClientQueueTransport(),
});
