import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { ConnectivityService } from './connectivity.service';
import { QUIET_REQUEST } from './quiet-request';

/**
 * Avisa o `ConnectivityService` quando uma requisição falha sem resposta ou volta a funcionar. Os pedidos marcados com
 * `QUIET_REQUEST` (o envio da telemetria) ficam de fora: nem a falha nem o sucesso deles dizem nada sobre o servidor para o app.
 */
export const connectivityInterceptor: HttpInterceptorFn = (request, next) => {
  if (request.context.get(QUIET_REQUEST)) return next(request);
  const connectivity = inject(ConnectivityService);
  return next(request).pipe(
    tap({
      next: (event) => {
        if (event instanceof HttpResponse) connectivity.reportRequestSuccess();
      },
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse && error.status === 0) {
          connectivity.reportRequestFailure();
        }
      },
    }),
  );
};
