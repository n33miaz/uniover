import { Injectable, InjectionToken, inject } from '@angular/core';
import { IDEMPOTENCY_HEADER, IdempotencyKeys } from '../api/idempotency';
import { APP_CONFIG } from '../config/app-config';
import { ConnectivityService } from '../connectivity/connectivity.service';
import type { components } from '../api/generated/schema';
import { networkProblem, problemFrom } from './api-problem';

/** `fetch` injetável: os testes trocam por um falso. */
export const FETCH_FN = new InjectionToken<typeof fetch>('FETCH_FN', {
  providedIn: 'root',
  factory: () => (input, init) => globalThis.fetch(input, init),
});

/** Cabeçalho que a API exige em todo POST para `/identity/auth/*` e no aceite do convite (defesa extra contra CSRF). */
export const CLIENT_HEADER = 'X-UniOver-Client';
export const CLIENT_HEADER_VALUE = 'web';

/** Tipos gerados do OpenAPI da API (`npm --prefix contracts run generate`): nunca editados à mão. */
type Schemas = components['schemas'];

/** Única rota pública além do login e do refresh que também exige o cabeçalho do cliente. */
const ACCEPT_INVITE_PATH = '/guest-invites/accept';

const IDENTITY_BASE = `${APP_CONFIG.apiBase}/v1/identity`;

/** Resposta de login e de renovação: token de acesso e validade em segundos. */
export type TokenResponse = Readonly<Schemas['LoginResponse']>;
export type MeResponse = Readonly<Schemas['MeResponse']>;
export type PasskeySummary = Readonly<Schemas['PasskeySummary']>;
/** Opções do WebAuthn como a API as entrega: JSON do servidor, ainda com os binários em base64url. */
export type WebAuthnChallenge = Readonly<Schemas['RequestStepUpResponse']>;
export type StepUpConfirmation = Readonly<Schemas['ConfirmStepUpResponse']>;
export type StreamTicket = Readonly<Schemas['StreamTicketResponse']>;
export type ModuleInfo = Readonly<Schemas['IdentityModuleInfo']>;
export type DeploymentVersion = Readonly<Schemas['DeploymentVersion']>;
export type GuestInviteSummary = Readonly<Schemas['GuestInviteSummary']>;
export type GuestInviteCreated = Readonly<Schemas['CreateGuestInviteResponse']>;
export type GuestSummary = Readonly<Schemas['GuestSummary']>;
export type LoginSession = Readonly<Schemas['SessionSummary']>;
export type QrLoginStarted = Readonly<Schemas['StartQrLoginResponse']>;
export type QrLoginPoll = Readonly<Schemas['PollQrLoginResponse']>;
export type QrLoginInfo = Readonly<Schemas['QrLoginInfoResponse']>;

interface RequestOptions {
  readonly token?: string | null;
  readonly body?: unknown;
}

/**
 * Cliente mínimo do módulo de identidade. Pedidos e respostas vêm tipados do OpenAPI gerado. Cada método
 * devolve o corpo ou lança `ApiProblem` (status 0 = sem resposta). Os métodos autenticados recebem o token do
 * chamador: quem renova e repete o pedido é o `AuthService`.
 */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly doFetch = inject(FETCH_FN);
  private readonly connectivity = inject(ConnectivityService);
  private readonly idempotency = inject(IdempotencyKeys);

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

  /** O nome que a própria pessoa escolheu; a API o normaliza, confirma e devolve a conta como ficou. */
  updateMe(token: string, displayName: string): Promise<MeResponse> {
    const body: Schemas['UpdateProfileRequest'] = { displayName };
    return this.send('PATCH', '/me', { token, body });
  }

  /** Troca o JWT por um bilhete curto em cookie, para abrir o SSE sem token na URL. */
  streamTicket(token: string): Promise<StreamTicket> {
    return this.send('POST', '/auth/stream-ticket', { token });
  }

  /**
   * Aceita o convite do dono: a pessoa escolhe e-mail e senha e já sai com a sessão aberta (como no login). Rota
   * pública; o segredo do convite viaja só no corpo, nunca na URL.
   */
  acceptInvite(token: string, email: string, password: string): Promise<TokenResponse> {
    const body: Schemas['AcceptGuestInviteRequest'] = { token, email, password };
    return this.send('POST', '/guest-invites/accept', { body });
  }

  /** Computador sem sessão pede um QR de entrada. O `pollSecret` só este navegador guarda; o `code` vai no QR. */
  qrStart(): Promise<QrLoginStarted> {
    return this.send('POST', '/auth/qr/start');
  }

  /** Consulta do computador. Aprovado, a resposta traz o token de acesso e o cookie de refresh já vem junto. */
  qrPoll(secret: string): Promise<QrLoginPoll> {
    const body: Schemas['PollQrLoginRequest'] = { secret };
    return this.send('POST', '/auth/qr/poll', { body });
  }

  /** O celular (logado) vê o que o computador informou antes de confirmar. */
  qrInfo(token: string, code: string): Promise<QrLoginInfo> {
    const body: Schemas['QrLoginCodeRequest'] = { code };
    return this.send('POST', '/auth/qr/info', { token, body });
  }

  /**
   * Confirma a entrada do computador. Com passkey a API pede a confirmação (o `AuthService` abre o diálogo e repete); sem
   * passkey e com a sessão antiga, pede a senha.
   */
  qrApprove(token: string, code: string, password: string | null): Promise<void> {
    const body: Schemas['ApproveQrLoginRequest'] = { code, password };
    return this.send('POST', '/auth/qr/approve', { token, body });
  }

  qrDeny(token: string, code: string): Promise<void> {
    const body: Schemas['QrLoginCodeRequest'] = { code };
    return this.send('POST', '/auth/qr/deny', { token, body });
  }

  guestInvites(token: string): Promise<readonly GuestInviteSummary[]> {
    return this.send('GET', '/guest-invites', { token });
  }

  /** Gerar o convite concede acesso: a API pede a confirmação com a passkey (o `AuthService` abre o diálogo e repete). */
  createGuestInvite(token: string, displayName: string): Promise<GuestInviteCreated> {
    const body: Schemas['CreateGuestInviteRequest'] = { displayName };
    return this.send('POST', '/guest-invites', { token, body });
  }

  revokeGuestInvite(token: string, id: string): Promise<void> {
    return this.send('POST', `/guest-invites/${encodeURIComponent(id)}/revoke`, { token });
  }

  guests(token: string): Promise<readonly GuestSummary[]> {
    return this.send('GET', '/guests', { token });
  }

  revokeGuest(token: string, id: string): Promise<void> {
    return this.send('POST', `/guests/${encodeURIComponent(id)}/revoke`, { token });
  }

  sessions(token: string, guestId: string | null = null): Promise<readonly LoginSession[]> {
    const path = guestId === null ? '/sessions' : `/guests/${encodeURIComponent(guestId)}/sessions`;
    return this.send('GET', path, { token });
  }

  revokeSession(token: string, id: string, guestId: string | null = null): Promise<void> {
    const path =
      guestId === null
        ? `/sessions/${encodeURIComponent(id)}/revoke`
        : `/guests/${encodeURIComponent(guestId)}/sessions/${encodeURIComponent(id)}/revoke`;
    return this.send('POST', path, { token });
  }

  revokeOtherSessions(token: string): Promise<void> {
    return this.send('POST', '/sessions/others/revoke', { token });
  }

  info(): Promise<ModuleInfo> {
    return this.send('GET', '/info');
  }

  /** A versão publicada é pública e serve para mostrar exatamente o produto que está em execução. */
  async deploymentVersion(): Promise<DeploymentVersion> {
    let response: Response;
    try {
      response = await this.doFetch(`${APP_CONFIG.apiBase}/health/version`, {
        headers: { Accept: 'application/json, application/problem+json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch {
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
    return (await readJson(response)) as DeploymentVersion;
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

  /**
   * O passo forte do CONVIDADO, que não tem passkey: digitar a senha de novo. Vale poucos minutos, só nesta sessão e só
   * para as ações da lista fechada da API (hoje, aprovar o pareamento do próprio PC); o dono usa a passkey.
   */
  stepUpWithPassword(token: string, action: string, password: string): Promise<StepUpConfirmation> {
    const body: Schemas['ConfirmStepUpWithPasswordRequest'] = { action, password };
    return this.send('POST', '/step-up/password', { token, body });
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
    if (method === 'POST' && (path.startsWith('/auth/') || path === ACCEPT_INVITE_PATH))
      headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    // Escritas reenviáveis (perfil, convites, sessões, passkeys) exigem a chave; o reenvio da mesma ação a reaproveita.
    const ticket = this.idempotency.begin(method, `${IDENTITY_BASE}${path}`, body ?? '');
    if (ticket.key !== null) headers[IDEMPOTENCY_HEADER] = ticket.key;

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
      ticket.settle(0);
      throw networkProblem();
    }
    this.connectivity.reportRequestSuccess();

    if (!response.ok) {
      const problem = problemFrom(
        response.status,
        await readJson(response),
        response.headers.get('Retry-After'),
      );
      ticket.settle(problem.status, problem.kind);
      throw problem;
    }
    ticket.settle(response.status);
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
