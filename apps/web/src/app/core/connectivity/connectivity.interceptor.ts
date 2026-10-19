import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { ConnectivityService } from './connectivity.service';

/** Avisa o `ConnectivityService` quando uma requisição falha sem resposta ou volta a funcionar. */
export const connectivityInterceptor: HttpInterceptorFn = (request, next) => {
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
