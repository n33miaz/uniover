import { Injectable, InjectionToken, inject } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { networkProblem, problemFrom } from './api-problem';

/** `fetch` injetável: os testes trocam por um falso. */
export const FETCH_FN = new InjectionToken<typeof fetch>('FETCH_FN', {
  providedIn: 'root',
  factory: () => (input, init) => globalThis.fetch(input, init),
});

/** Cabeçalho que a API exige em todo POST para `/identity/auth/*` (defesa extra contra CSRF). */
export const CLIENT_HEADER = 'X-UniOver-Client';
export const CLIENT_HEADER_VALUE = 'web';

const IDENTITY_BASE = `${APP_CONFIG.apiBase}/v1/identity`;

export interface TokenResponse {
  readonly accessToken: string;
  /** Validade do token de acesso, em segundos. */
  readonly expiresIn: number;
}

export interface MeResponse {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** Opções do WebAuthn como a API as entrega: JSON do servidor, ainda com os binários em base64url. */
export interface WebAuthnChallenge {
  readonly challengeId: string;
  readonly options: unknown;
}

export interface StepUpConfirmation {
  readonly action: string;
  readonly expiresAt: string;
}

export interface ModuleInfo {
  readonly module: string;
  readonly version: string;
  readonly dependsOn: readonly string[];
}

interface RequestOptions {
  readonly token?: string | null;
  readonly body?: unknown;
}

/**
 * Cliente mínimo do módulo de identidade, escrito à mão. Dívida declarada: a geração de tipos a partir do
 * OpenAPI o substitui quando existir, e este arquivo some. Cada método devolve o corpo ou lança `ApiProblem`
 * (status 0 = sem resposta). Os métodos autenticados recebem o token do chamador: quem renova e repete o
 * pedido é o `AuthService`.
 */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly doFetch = inject(FETCH_FN);
  private readonly connectivity = inject(ConnectivityService);

  login(email: string, password: string): Promise<TokenResponse> {
    return this.send('POST', '/auth/login', { body: { email, password } });
  }

  /** O cookie `HttpOnly` de refresh viaja sozinho (o JavaScript não o lê). */
  refresh(): Promise<TokenResponse> {
    return this.send('POST', '/auth/refresh');
  }

  logout(token: string): Promise<void> {
    return this.send('POST', '/auth/logout', { token });
  }

  me(token: string): Promise<MeResponse> {
    return this.send('GET', '/me', { token });
  }

  /** Troca o JWT por um bilhete curto em cookie, para abrir o SSE sem token na URL. */
  streamTicket(token: string): Promise<{ readonly expiresIn: number }> {
    return this.send('POST', '/auth/stream-ticket', { token });
  }

  info(): Promise<ModuleInfo> {
    return this.send('GET', '/info');
  }

  stepUpOptions(token: string, action: string): Promise<WebAuthnChallenge> {
    return this.send('POST', '/step-up/options', { token, body: { action } });
  }

  stepUpComplete(
    token: string,
    challengeId: string,
    credential: unknown,
  ): Promise<StepUpConfirmation> {
    return this.send('POST', '/step-up/complete', { token, body: { challengeId, credential } });
  }

  passkeys(token: string): Promise<readonly PasskeySummary[]> {
    return this.send('GET', '/passkeys', { token });
  }

  /** Cadastro pede a senha de novo: sessão roubada não consegue registrar a passkey do atacante. */
  registrationOptions(token: string, password: string): Promise<WebAuthnChallenge> {
    return this.send('POST', '/passkeys/registration/options', { token, body: { password } });
  }

  registrationComplete(
    token: string,
    challengeId: string,
    name: string | null,
    credential: unknown,
  ): Promise<PasskeySummary> {
    return this.send('POST', '/passkeys/registration/complete', {
      token,
      body: { challengeId, name, credential },
    });
  }

  renamePasskey(token: string, id: string, name: string): Promise<PasskeySummary> {
    return this.send('PATCH', `/passkeys/${encodeURIComponent(id)}`, { token, body: { name } });
  }

  removePasskey(token: string, id: string): Promise<void> {
    return this.send('DELETE', `/passkeys/${encodeURIComponent(id)}`, { token });
  }

  private async send<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
    };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (method === 'POST' && path.startsWith('/auth/'))
      headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.doFetch(`${IDENTITY_BASE}${path}`, {
        method,
        headers,
        body,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch {
      // Sem resposta: o serviço de conexão decide entre "offline" e "servidor acordando".
      this.connectivity.reportRequestFailure();
      throw networkProblem();
    }
    this.connectivity.reportRequestSuccess();

    if (!response.ok) {
      throw problemFrom(
        response.status,
        await readJson(response),
        response.headers.get('Retry-After'),
      );
    }
    if (response.status === 204) return undefined as T;
    return (await readJson(response)) as T;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
