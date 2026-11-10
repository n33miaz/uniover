import { HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { retry, throwError, timer } from 'rxjs';
import { problemOf } from '../auth/api-problem';
import { ConnectivityService } from './connectivity.service';

export interface ResumeRetryConfig {
  /** Quantas vezes uma leitura que caiu na volta ao app é refeita em silêncio. */
  readonly maxRetries: number;
  /** Espera entre as repetições: dá tempo de o navegador abrir uma conexão nova no lugar da derrubada. */
  readonly delayMs: number;
}

export const RESUME_RETRY_CONFIG = new InjectionToken<ResumeRetryConfig>('RESUME_RETRY_CONFIG', {
  providedIn: 'root',
  factory: () => ({ maxRetries: 2, delayMs: 800 }),
});

/**
 * Refaz em silêncio a leitura (GET e HEAD) que falha sem resposta enquanto o app acaba de voltar (carência de
 * `ResumeGrace`) ou a checagem decisiva de conexão está em voo. Ao voltar do segundo plano o primeiro pedido costuma sair numa
 * conexão que o sistema já derrubou; refeito, passa. Só leituras: um comando (tecla da TV, clique do PC) repetido por conta
 * própria agiria duas vezes, e o que o app grava vai pela fila offline, que já tem a sua repetição. Fica DEPOIS do
 * interceptador de conectividade, que só vê o resultado final: uma leitura salva pela repetição nunca é contada como falha.
 */
export const resumeRetryInterceptor: HttpInterceptorFn = (request, next) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return next(request);
  const connectivity = inject(ConnectivityService);
  const config = inject(RESUME_RETRY_CONFIG);
  return next(request).pipe(
    retry({
      count: config.maxRetries,
      delay: (error: unknown) =>
        problemOf(error)?.isNetwork === true && connectivity.quiet()
          ? timer(config.delayMs)
          : throwError(() => error),
    }),
  );
};
