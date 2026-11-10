import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { QUIET_REQUEST } from '../connectivity/quiet-request';
import { ClientTelemetry } from './client-telemetry';

/**
 * Registra, para consulta depois, a requisição que falhou (sem resposta, erro de servidor, limite de uso, comando recusado).
 * Fica por fora de tudo: vê o resultado final, já depois das repetições silenciosas da volta ao app. O envio da própria
 * telemetria é marcado (`QUIET_REQUEST`) e nunca entra aqui.
 */
export const telemetryInterceptor: HttpInterceptorFn = (request, next) => {
  if (request.context.get(QUIET_REQUEST)) return next(request);
  const telemetry = inject(ClientTelemetry);
  return next(request).pipe(
    tap({
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse) {
          telemetry.recordHttp(request.method, request.url, error);
        }
      },
    }),
  );
};
