import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, Injector, inject } from '@angular/core';
import { Router, UrlTree } from '@angular/router';
import { SessionState } from '../session/session-state';
import { ApiProblem, isStepUpRequired, networkProblem, problemOf } from './api-problem';
import { AuthApi } from './auth-api';
import { safeNextUrl } from './next-url';
import { StepUpService } from './step-up/step-up.service';

export interface AuthConfig {
  /**
   * Quanto o app espera a primeira renovação antes de abrir a casca em "sessão a confirmar". Curto de propósito:
   * um servidor dormindo pode segurar a resposta por minutos e a tela não pode esperar por isso. A renovação
   * continua em segundo plano e corrige o estado quando termina.
   */
  readonly initTimeoutMs: number;
  /** Espera antes de repetir o refresh que deu 409 (a outra aba acabou de girar o cookie). */
  readonly conflictRetryMs: number;
  /** Intervalo entre tentativas de confirmar a sessão enquanto ela está pendente. */
  readonly pendingRetryMs: number;
  /** Fração da validade do token em que o refresh é agendado. */
  readonly renewAtRatio: number;
  /** Se o token vence em menos que isto, renovar antes de usar (e ao voltar para a aba). */
  readonly minLeadMs: number;
}

export const AUTH_CONFIG = new InjectionToken<AuthConfig>('AUTH_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    initTimeoutMs: 3_000,
    conflictRetryMs: 250,
    pendingRetryMs: 30_000,
    renewAtRatio: 0.8,
    minLeadMs: 60_000,
  }),
});

/** `renewed`: token novo · `unauthenticated`: o servidor recusou o cookie (sessão acabou) · `unavailable`: sem resposta útil. */
export type RenewOutcome = 'renewed' | 'unauthenticated' | 'unavailable';

/** Nome do bloqueio entre abas: só uma renovação por vez em todo o navegador. */
const RENEW_LOCK = 'uniover-refresh';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sessão do dono. Regras que moldam este serviço:
 * - o token de acesso só existe em memória (`SessionState`); a continuidade vem do cookie de refresh;
 * - só um 401 do refresh encerra a sessão; rede, 404 e 5xx deixam `pending` e **nunca** apagam dado local;
 * - uma renovação por vez: dentro da aba, uma promessa compartilhada; entre abas, `navigator.locks`.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly config = inject(AUTH_CONFIG);
  private readonly doc = inject(DOCUMENT);
  private readonly win = this.doc.defaultView;

  readonly status = this.session.status;
  readonly user = this.session.user;

  private initPromise: Promise<void> | null = null;
  private renewing: Promise<RenewOutcome> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    const onVisible = () => {
      if (this.doc.visibilityState !== 'visible') return;
      const status = this.session.status();
      const expiring = this.session.bearer(Date.now() + this.config.minLeadMs) === null;
      if (status === 'pending' || (status === 'authenticated' && expiring)) void this.renew();
    };
    const onOnline = () => {
      if (this.session.status() === 'pending') void this.renew();
    };
    this.doc.addEventListener('visibilitychange', onVisible);
    this.win?.addEventListener('online', onOnline);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', onVisible);
      this.win?.removeEventListener('online', onOnline);
      this.stopTimers();
    });
  }

  /**
   * Primeira confirmação da sessão pelo cookie de refresh. Idempotente (uma só promessa) e limitada no tempo:
   * 200 → `authenticated`; 401 → `anonymous`; qualquer outra coisa ou demora → `pending`.
   */
  init(): Promise<void> {
    this.initPromise ??= this.runInit();
    return this.initPromise;
  }

  async login(email: string, password: string): Promise<void> {
    const tokens = await this.api.login(email, password);
    this.session.setToken(tokens.accessToken, tokens.expiresIn);
    this.scheduleRenewal(tokens.expiresIn);
    this.stopPendingRetry();
    await this.loadUser(tokens.accessToken);
  }

  /**
   * Encerra a sessão neste aparelho. Zera só a memória: IndexedDB e filas locais ficam como estão. Devolve
   * `false` se o servidor não confirmou (sem rede): o cookie de refresh pode continuar valendo até a próxima
   * chamada que o servidor conseguir receber.
   */
  async logout(): Promise<boolean> {
    let confirmed = true;
    if (this.session.status() !== 'anonymous') {
      try {
        await this.authorized((token) => this.api.logout(token), { stepUp: false });
      } catch {
        confirmed = false;
      }
    }
    this.stopTimers();
    this.session.clear('anonymous');
    await this.router.navigate(['/entrar'], { replaceUrl: true });
    return confirmed;
  }

  /** Renova o token de acesso. Uma por vez na aba e entre abas; chamadas simultâneas dividem o resultado. */
  renew(): Promise<RenewOutcome> {
    this.renewing ??= this.renewUnderLock().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  /**
   * Executa uma chamada autenticada: garante token válido, renova **uma** vez e repete se vier 401, e, se vier
   * 403 de confirmação pendente, pede a passkey e repete **uma** vez. Nunca entra em laço.
   */
  async authorized<T>(
    call: (token: string) => Promise<T>,
    options: { readonly stepUp?: boolean } = {},
  ): Promise<T> {
    const token = await this.validToken();
    try {
      return await call(token);
    } catch (error) {
      const problem = problemOf(error);
      if (!problem) throw error;

      if (problem.status === 401) {
        // Outra chamada pode já ter renovado enquanto esta voava: então basta repetir com o token novo.
        const current = this.session.bearer();
        if (current && current !== token) return call(current);
        const outcome = await this.renew();
        const fresh = this.session.bearer();
        if (outcome !== 'renewed' || !fresh) throw error;
        return call(fresh);
      }

      if ((options.stepUp ?? true) && isStepUpRequired(problem) && problem.action) {
        const confirmed = await this.injector.get(StepUpService).confirm(problem.action);
        if (!confirmed) throw error;
        return call(await this.validToken());
      }
      throw error;
    }
  }

  /** Token válido agora (renovando se preciso) ou `null`: para quem prefere seguir sem ele a falhar. */
  async accessToken(): Promise<string | null> {
    try {
      return await this.validToken();
    } catch {
      return null;
    }
  }

  /** Árvore de URL do login para o guarda; `next` só entra se for um caminho seguro da própria origem. */
  loginUrlTree(returnTo: string): UrlTree {
    const next = safeNextUrl(returnTo, this.origin());
    return this.router.createUrlTree(['/entrar'], {
      queryParams: next && next !== '/' ? { next } : {},
    });
  }

  private origin(): string {
    return this.win?.location.origin ?? 'http://localhost';
  }

  private async validToken(): Promise<string> {
    const token = this.session.bearer(Date.now() + this.config.minLeadMs);
    if (token) return token;
    if (this.session.status() === 'anonymous') {
      throw new ApiProblem(401, 'unauthenticated', 'Sessão inválida ou expirada.');
    }
    const outcome = await this.renew();
    // Se a renovação falhou mas o token ainda dura alguns segundos, ele serve.
    const usable = this.session.bearer();
    if (usable) return usable;
    throw outcome === 'unauthenticated'
      ? new ApiProblem(401, 'unauthenticated', 'Sessão inválida ou expirada.')
      : networkProblem();
  }

  private async runInit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.config.initTimeoutMs);
    });
    const winner = await Promise.race([this.renew(), timeout]);
    clearTimeout(timer);
    if (winner === 'timeout' && this.session.status() === 'unknown') {
      this.session.setPending();
      this.startPendingRetry();
    }
  }

  private renewUnderLock(): Promise<RenewOutcome> {
    const locks = this.win?.navigator?.locks;
    return locks?.request ? locks.request(RENEW_LOCK, () => this.doRenew()) : this.doRenew();
  }

  private async doRenew(): Promise<RenewOutcome> {
    const wasKnown = this.session.status() !== 'unknown';
    try {
      const tokens = await this.refreshOnce();
      this.session.setToken(tokens.accessToken, tokens.expiresIn);
      this.scheduleRenewal(tokens.expiresIn);
      this.stopPendingRetry();
      if (!this.session.user()) await this.loadUser(tokens.accessToken);
      return 'renewed';
    } catch (error) {
      if (error instanceof ApiProblem && error.status === 401) {
        this.stopTimers();
        this.session.clear('anonymous');
        if (wasKnown) this.redirectToLogin();
        return 'unauthenticated';
      }
      // Rede, 404, 5xx, 429, 409 repetido: não dá para confirmar, mas nada se apaga.
      this.session.setPending();
      this.startPendingRetry();
      return 'unavailable';
    }
  }

  /** Um refresh; se duas abas giraram o cookie juntas (409), espera um instante e tenta mais uma vez. */
  private async refreshOnce() {
    try {
      return await this.api.refresh();
    } catch (error) {
      if (
        error instanceof ApiProblem &&
        error.status === 409 &&
        error.kind === 'refresh-conflict'
      ) {
        await sleep(this.config.conflictRetryMs);
        return this.api.refresh();
      }
      throw error;
    }
  }

  private async loadUser(token: string): Promise<void> {
    try {
      this.session.setUser(await this.api.me(token));
    } catch {
      // O nome é conforto; sem ele a sessão vale do mesmo jeito.
    }
  }

  private scheduleRenewal(expiresInSeconds: number): void {
    clearTimeout(this.renewTimer);
    const delay = Math.max(1_000, Math.round(expiresInSeconds * 1_000 * this.config.renewAtRatio));
    this.renewTimer = setTimeout(() => void this.renew(), delay);
  }

  private startPendingRetry(): void {
    if (this.pendingTimer !== undefined || this.session.status() !== 'pending') return;
    this.pendingTimer = setInterval(() => {
      if (this.session.status() === 'pending') void this.renew();
      else this.stopPendingRetry();
    }, this.config.pendingRetryMs);
  }

  private stopPendingRetry(): void {
    if (this.pendingTimer !== undefined) clearInterval(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  private stopTimers(): void {
    clearTimeout(this.renewTimer);
    this.renewTimer = undefined;
    this.stopPendingRetry();
  }

  private redirectToLogin(): void {
    const url = this.router.url;
    if (url.startsWith('/entrar')) return;
    void this.router.navigateByUrl(this.loginUrlTree(url), { replaceUrl: true });
  }
}
