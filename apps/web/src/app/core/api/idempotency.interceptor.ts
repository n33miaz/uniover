import { DOCUMENT } from '@angular/common';
import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { problemOf } from '../auth/api-problem';
import { IDEMPOTENCY_HEADER, IdempotencyKeys } from './idempotency';

/**
 * Põe `Idempotency-Key` nas escritas do `HttpClient` que a API exige (ver `ROUTES` em `idempotency.ts`).
 *
 * Fica DEPOIS do interceptador de autenticação na cadeia, de propósito: a renovação da sessão e a repetição depois da
 * passkey chamam o `next` de novo, e cada passagem decide a chave pelo resultado da anterior (uma resposta 4xx do pedido
 * fica guardada na API sob a chave, e repeti-la devolveria a mesma resposta). Só põe o cabeçalho que ainda não existe.
 */
export const idempotencyInterceptor: HttpInterceptorFn = (request, next) => {
  const origin = inject(DOCUMENT).defaultView?.location.origin ?? 'http://localhost';
  if (request.headers.has(IDEMPOTENCY_HEADER)) return next(request);

  let sameOrigin: boolean;
  try {
    sameOrigin = new URL(request.url, origin).origin === new URL(origin).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return next(request);

  const serialized = request.serializeBody();
  const ticket = inject(IdempotencyKeys).begin(
    request.method,
    request.url,
    typeof serialized === 'string' ? serialized : '',
  );
  if (ticket.key === null) return next(request);

  return next(request.clone({ setHeaders: { [IDEMPOTENCY_HEADER]: ticket.key } })).pipe(
    tap({
      next: (event) => {
        if (event instanceof HttpResponse) ticket.settle(event.status);
      },
      error: (error: unknown) => {
        const problem = problemOf(error);
        ticket.settle(problem?.status ?? 0, problem?.kind);
      },
    }),
  );
};
