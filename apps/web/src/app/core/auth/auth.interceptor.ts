import { DOCUMENT } from '@angular/common';
import { HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, lastValueFrom, switchMap } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';
import { SessionState } from '../session/session-state';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from './auth-api';
import { AuthService } from './auth.service';

const AUTH_PATH = `${APP_CONFIG.apiBase}/v1/identity/auth/`;

/** Caminho da requisição se ela vai para a API da mesma origem; `null` para qualquer outro destino. */
function sameOriginApiPath(url: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== new URL(origin).origin) return null;
  return parsed.pathname.startsWith(`${APP_CONFIG.apiBase}/`) ? parsed.pathname : null;
}

/**
 * Autenticação das chamadas do `HttpClient`:
 * - `Authorization: Bearer` só em pedidos para `/api/` da mesma origem, nunca em `login` e `refresh`;
 * - `X-UniOver-Client: web` em todo POST para `/api/v1/identity/auth/*` (o login também);
 * - 401 → uma renovação e **uma** repetição; 403 de confirmação pendente → passkey e **uma** repetição;
 * - falha de rede não mexe na sessão (quem classifica offline/servidor dormindo é o `ConnectivityService`).
 *
 * Só põe cabeçalho que ainda não existe, então registrá-lo junto de outro dono do mesmo cabeçalho é inofensivo.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const session = inject(SessionState);
  const origin = inject(DOCUMENT).defaultView?.location.origin ?? 'http://localhost';

  const path = sameOriginApiPath(request.url, origin);
  if (path === null) return next(request);

  const withClientHeader = (req: HttpRequest<unknown>): HttpRequest<unknown> =>
    req.method === 'POST' && path.startsWith(AUTH_PATH) && !req.headers.has(CLIENT_HEADER)
      ? req.clone({ setHeaders: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } })
      : req;

  // Login e refresh não levam o token (o refresh usa o cookie).
  const credentialless = path === `${AUTH_PATH}login` || path === `${AUTH_PATH}refresh`;
  if (credentialless || session.status() === 'anonymous' || request.headers.has('Authorization')) {
    return next(withClientHeader(request));
  }

  return from(auth.accessToken()).pipe(
    switchMap((token) => {
      // Sem token utilizável (sessão pendente sem rede): segue sem ele e deixa o servidor ou a rede responderem.
      if (!token) return next(withClientHeader(request));
      return from(
        auth.authorized((fresh) =>
          lastValueFrom(
            next(
              withClientHeader(request.clone({ setHeaders: { Authorization: `Bearer ${fresh}` } })),
            ),
          ),
        ),
      );
    }),
  );
};
