import { HttpClient, HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { catchError, firstValueFrom, map, of, timeout } from 'rxjs';
import { SendOutcome } from './classify-result';
import { OutboxMethod } from './offline-db';

export interface QueueRequest {
  readonly method: OutboxMethod;
  readonly url: string;
  readonly body: unknown;
  /** Sempre traz `Idempotency-Key` e `Content-Type`. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Porta de saída da fila. O adaptador padrão usa o `HttpClient` do app (então os interceptadores de conexão e de
 * autenticação valem para a fila); o teste injeta um transporte falso.
 */
export interface QueueTransport {
  send(request: QueueRequest): Promise<SendOutcome>;
}

/** Quanto esperar uma resposta antes de dar a tentativa por perdida e voltar ao backoff. */
export const SEND_TIMEOUT_MS = 60_000;

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

export class HttpClientQueueTransport implements QueueTransport {
  private readonly http = inject(HttpClient);

  send(request: QueueRequest): Promise<SendOutcome> {
    return firstValueFrom(
      this.http
        .request(request.method, request.url, {
          body: request.body === undefined ? null : JSON.stringify(request.body),
          headers: new HttpHeaders(request.headers),
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
