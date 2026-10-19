import { Injectable, InjectionToken, inject } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';
import { ConnectivityService } from '../connectivity/connectivity.service';
import type { components } from '../api/generated/schema';
import { networkProblem, problemFrom } from './api-problem';

/** `fetch` injetável: os testes trocam por um falso. */
export const FETCH_FN = new InjectionToken<typeof fetch>('FETCH_FN', {
  providedIn: 'root',
  factory: () => (input, init) => globalThis.fetch(input, init),
});

/** Cabeçalho que a API exige em todo POST para `/identity/auth/*` (defesa extra contra CSRF). */
export const CLIENT_HEADER = 'X-UniOver-Client';
export const CLIENT_HEADER_VALUE = 'web';

/** Tipos gerados do OpenAPI da API (`npm --prefix contracts run generate`): nunca editados à mão. */
type Schemas = components['schemas'];

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

export type ModuleInfo = Readonly<Schemas['IdentityModuleInfo']>;

interface RequestOptions {
  readonly token?: string | null;
  readonly body?: unknown;
}

/**
 * Cliente mínimo do módulo de identidade. Os corpos de pedido vêm tipados do OpenAPI gerado. As respostas
 * acima continuam escritas à mão porque a API ainda não declara o tipo de resposta dos endpoints (o
 * documento traz só o código 200, sem corpo); quando declarar, elas passam a ser as geradas. Cada método devolve o corpo ou lança `ApiProblem`
 * (status 0 = sem resposta). Os métodos autenticados recebem o token do chamador: quem renova e repete o
 * pedido é o `AuthService`.
 */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly doFetch = inject(FETCH_FN);
  private readonly connectivity = inject(ConnectivityService);

  login(email: string, password: string): Promise<TokenResponse> {
    const body: Schemas['LoginRequest'] = { email, password };
    return this.send('POST', '/auth/login', { body });
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
    const body: Schemas['RequestStepUpRequest'] = { action };
    return this.send('POST', '/step-up/options', { token, body });
  }

  stepUpComplete(
    token: string,
    challengeId: string,
    credential: unknown,
  ): Promise<StepUpConfirmation> {
    // A credencial do WebAuthn chega como o navegador a serializa; o servidor a valida.
    const body = { challengeId, credential } as Schemas['ConfirmStepUpRequest'];
    return this.send('POST', '/step-up/complete', { token, body });
  }

  passkeys(token: string): Promise<readonly PasskeySummary[]> {
    return this.send('GET', '/passkeys', { token });
  }

  /** Cadastro pede a senha de novo: sessão roubada não consegue registrar a passkey do atacante. */
  registrationOptions(token: string, password: string): Promise<WebAuthnChallenge> {
    const body: Schemas['BeginPasskeyRegistrationRequest'] = { password };
    return this.send('POST', '/passkeys/registration/options', { token, body });
  }

  registrationComplete(
    token: string,
    challengeId: string,
    name: string | null,
    credential: unknown,
  ): Promise<PasskeySummary> {
    const body = { challengeId, name, credential } as Schemas['CompletePasskeyRegistrationRequest'];
    return this.send('POST', '/passkeys/registration/complete', { token, body });
  }

  renamePasskey(token: string, id: string, name: string): Promise<PasskeySummary> {
    const body: Schemas['RenamePasskeyRequest'] = { name };
    return this.send('PATCH', `/passkeys/${encodeURIComponent(id)}`, { token, body });
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
