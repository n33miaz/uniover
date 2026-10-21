import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, Injector, inject } from '@angular/core';
import { Router, UrlTree } from '@angular/router';
import { SessionState } from '../session/session-state';
import {
  ApiProblem,
  isPermissionDenied,
  isStepUpRequired,
  networkProblem,
  problemOf,
} from './api-problem';
import { AuthApi, MeResponse } from './auth-api';
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
  /**
   * Idade máxima da última leitura de `/me` para o gatilho "voltei para a tela". A API reavalia as permissões com cache
   * de 30 s: reler antes disso não traria nada novo, só gasto de rede.
   */
  readonly userMaxAgeMs: number;
  /** Piso entre duas leituras de `/me` provocadas por um 403 de acesso: a recusa pode desmentir a tela, mas nunca vira tempestade. */
  readonly userMinGapMs: number;
}

export const AUTH_CONFIG = new InjectionToken<AuthConfig>('AUTH_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    initTimeoutMs: 3_000,
    conflictRetryMs: 250,
    pendingRetryMs: 30_000,
    renewAtRatio: 0.8,
    minLeadMs: 60_000,
    userMaxAgeMs: 30_000,
    userMinGapMs: 5_000,
  }),
});

/** `renewed`: token novo · `unauthenticated`: o servidor recusou o cookie (sessão acabou) · `unavailable`: sem resposta útil. */
export type RenewOutcome = 'renewed' | 'unauthenticated' | 'unavailable';

/** O que levou a reler a conta: uma renovação de token, a volta da aba para o primeiro plano ou um 403 de acesso. */
export type UserRefreshTrigger = 'renewal' | 'foreground' | 'forbidden';

/** Opções de `authorized`: confirmar com a passkey e reler a conta quando a API recusa por falta de acesso (ambos ligados por padrão). */
interface AuthorizedOptions {
  readonly stepUp?: boolean;
  readonly rereadOnForbidden?: boolean;
}

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
  /** A leitura de `/me` em voo (todo gatilho a divide) e o instante em que a última começou (falha também conta). */
  private userRead: Promise<void> | null = null;
  private lastUserReadAt = Number.NEGATIVE_INFINITY;
  /** Intervalo mínimo para o próximo gatilho de 403: curto até uma leitura provocada por 403 voltar sem mudança. */
  private forbiddenGapMs = this.config.userMinGapMs;
  /** Muda ao encerrar a sessão: uma leitura que volta depois disso não pode devolver a conta que acabou de sair. */
  private sessionEpoch = 0;

  constructor() {
    const onForeground = () => {
      if (this.doc.visibilityState !== 'visible') return;
      const status = this.session.status();
      const expiring = this.session.bearer(Date.now() + this.config.minLeadMs) === null;
      // Renovar já relê a conta; só quando o token ainda dura é que a volta para a tela relê por conta própria.
      if (status === 'pending' || (status === 'authenticated' && expiring)) void this.renew();
      else if (status === 'authenticated') void this.refreshUser('foreground');
    };
    // Página restaurada do cache de ida e volta do navegador: nem sempre vem acompanhada de `visibilitychange`.
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) onForeground();
    };
    const onOnline = () => {
      if (this.session.status() === 'pending') void this.renew();
    };
    this.doc.addEventListener('visibilitychange', onForeground);
    this.win?.addEventListener('pageshow', onPageShow);
    this.win?.addEventListener('online', onOnline);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', onForeground);
      this.win?.removeEventListener('pageshow', onPageShow);
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

  /** Aceita o convite do dono e já abre a sessão do convidado (mesmo caminho do login depois da resposta). */
  async acceptInvite(token: string, email: string, password: string): Promise<void> {
    const tokens = await this.api.acceptInvite(token, email, password);
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
        await this.authorized((token) => this.api.logout(token), {
          stepUp: false,
          rereadOnForbidden: false,
        });
      } catch {
        confirmed = false;
      }
    }
    this.stopTimers();
    this.sessionEpoch++;
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
   *
   * Um 403 de acesso (a conta não tem o papel ou a permissão da rota) também faz a conta ser relida em segundo plano
   * (`refreshUser('forbidden')`), para a tela parar de oferecer o que a API recusa; o erro sobe igual, sem esperar.
   */
  async authorized<T>(
    call: (token: string) => Promise<T>,
    options: AuthorizedOptions = {},
  ): Promise<T> {
    // A repetição também pode ser recusada por acesso: só o resultado final de cada chamada é observado.
    const final = (run: Promise<T>): Promise<T> =>
      run.catch((error: unknown) => {
        this.noteDenied(error, options);
        throw error;
      });
    const token = await this.validToken();
    try {
      return await call(token);
    } catch (error) {
      const problem = problemOf(error);
      if (!problem) throw error;

      if (problem.status === 401) {
        // Outra chamada pode já ter renovado enquanto esta voava: então basta repetir com o token novo.
        const current = this.session.bearer();
        if (current && current !== token) return final(call(current));
        const outcome = await this.renew();
        const fresh = this.session.bearer();
        if (outcome !== 'renewed' || !fresh) throw error;
        return final(call(fresh));
      }

      if ((options.stepUp ?? true) && isStepUpRequired(problem) && problem.action) {
        const confirmed = await this.injector.get(StepUpService).confirm(problem.action);
        if (!confirmed) throw error;
        return final(call(await this.validToken()));
      }
      this.noteDenied(error, options);
      throw error;
    }
  }

  /**
   * Relê a conta (`GET /me`) para o nome, o papel e as permissões da tela acompanharem o servidor, que reavalia as
   * permissões a cada 30 s. É o único caminho dos três gatilhos: todos dividem a mesma leitura em voo e o mesmo teto de
   * idade, então nunca há tempestade de leituras nem polling de intervalo curto.
   * - `renewal`: sempre lê (renovar é raro e já trocou o token); entra na leitura que já estiver em voo.
   * - `foreground`: só se a última tentativa tem mais de `userMaxAgeMs`.
   * - `forbidden`: só depois do piso `userMinGapMs`. Se a leitura anterior provocada por um 403 voltou sem mudança, o 403
   *   não era permissão desatualizada (rota de administrador para um convidado, por exemplo): o teto volta a ser o
   *   inteiro até uma leitura trazer mudança. O administrador tem tudo, então nunca relê por 403.
   *
   * Mudou o conjunto de permissões (comparado pelo conteúdo)? O sinal troca uma vez; igual, não avisa ninguém. Falhar
   * (rede, 5xx) mantém o último valor, não derruba a sessão e deixa o próximo gatilho tentar de novo. Um 401 segue o
   * caminho de sempre da sessão vencida (renova; se o refresh também recusar, volta ao login). `freshToken` é o token
   * recém-emitido da renovação: lê com ele, sem passar pela validação que poderia renovar de novo. Nunca rejeita.
   */
  refreshUser(trigger: UserRefreshTrigger, freshToken?: string): Promise<void> {
    if (this.userRead) return this.userRead;
    if (this.session.status() !== 'authenticated') return Promise.resolve();
    if (trigger === 'forbidden' && this.session.role() === 'owner') return Promise.resolve();
    const gap =
      trigger === 'renewal'
        ? 0
        : trigger === 'foreground'
          ? this.config.userMaxAgeMs
          : this.forbiddenGapMs;
    if (Date.now() - this.lastUserReadAt < gap) return Promise.resolve();

    const read: Promise<void> = this.fetchUser(trigger, () =>
      freshToken
        ? this.api.me(freshToken)
        : this.authorized((token) => this.api.me(token), {
            stepUp: false,
            rereadOnForbidden: false,
          }),
    ).finally(() => {
      if (this.userRead === read) this.userRead = null;
    });
    this.userRead = read;
    return read;
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

  /** Mesmo caminho do login, para a pergunta do nome: o destino original vai em `next` e a pessoa volta a ele depois. */
  welcomeUrlTree(returnTo: string): UrlTree {
    const next = safeNextUrl(returnTo, this.origin());
    return this.router.createUrlTree(['/boas-vindas'], {
      queryParams: next && next !== '/' ? { next } : {},
    });
  }

  /**
   * O nome que a pessoa escolheu (a API o confirma). O usuário da sessão passa a ser o devolvido pela API: o nome novo
   * aparece na saudação da Início sem recarregar. Erro (400 por campo, 403, 429, sem rede) sobe para a tela mostrar; nada
   * é navegado nem guardado quando falha.
   */
  async updateDisplayName(displayName: string): Promise<void> {
    const me = await this.authorized((token) => this.api.updateMe(token, displayName), {
      stepUp: false,
    });
    this.session.setUser(me);
  }

  /**
   * Garante que o usuário da sessão esteja carregado quando há sessão confirmada: se a leitura logo depois do login
   * falhou (o servidor oscilou), tenta de novo uma vez. Falhar de novo não é erro: sem usuário, o guarda deixa a pessoa
   * seguir (rede ruim nunca a prende) e a pergunta do nome vem na próxima vez.
   */
  async ensureUser(): Promise<void> {
    if (this.session.user() || this.session.status() !== 'authenticated') return;
    // Falhar de novo não é erro (`fetchUser` engole): sem usuário a sessão vale do mesmo jeito (ver acima).
    await this.fetchUser(null, () =>
      this.authorized((token) => this.api.me(token), { stepUp: false, rereadOnForbidden: false }),
    );
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
    // A renovação demora a voltar; se a sessão foi encerrada nesse meio-tempo (Sair), o resultado é de uma sessão que
    // não existe mais e não pode recriá-la nem apagar o que veio depois.
    const epoch = this.sessionEpoch;
    try {
      const tokens = await this.refreshOnce();
      if (epoch !== this.sessionEpoch) return 'unauthenticated';
      this.session.setToken(tokens.accessToken, tokens.expiresIn);
      this.scheduleRenewal(tokens.expiresIn);
      this.stopPendingRetry();
      // Toda renovação relê a conta. Sem usuário carregado a leitura é aqui mesmo (os guardas dependem dele); com
      // usuário ela segue em segundo plano, para a renovação, que roda sob o bloqueio entre abas, não esperar por ela.
      if (!this.session.user()) await this.loadUser(tokens.accessToken);
      else void this.refreshUser('renewal', tokens.accessToken);
      return 'renewed';
    } catch (error) {
      if (epoch !== this.sessionEpoch) return 'unauthenticated';
      if (error instanceof ApiProblem && error.status === 401) {
        this.stopTimers();
        this.sessionEpoch++;
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

  /** Primeira leitura da conta com o token recém-emitido (login, convite, primeira renovação). */
  private loadUser(token: string): Promise<void> {
    return this.fetchUser(null, () => this.api.me(token));
  }

  /**
   * Faz a leitura de `/me` e aplica o resultado; é onde toda leitura passa. Marca o início da tentativa (falha também
   * conta para o teto) e engole qualquer erro: o nome e as permissões são conforto, sem a leitura fica o último valor e
   * a sessão vale do mesmo jeito. Descarta a resposta de uma sessão que já foi encerrada.
   */
  private async fetchUser(
    trigger: UserRefreshTrigger | null,
    read: () => Promise<MeResponse>,
  ): Promise<void> {
    this.lastUserReadAt = Date.now();
    const epoch = this.sessionEpoch;
    let me: MeResponse;
    try {
      me = await read();
    } catch {
      // Sem resposta útil a leitura de um 403 também não trouxe mudança: o próximo 403 espera o teto inteiro.
      if (trigger === 'forbidden') this.forbiddenGapMs = this.config.userMaxAgeMs;
      return;
    }
    if (epoch !== this.sessionEpoch) return;
    const changed = this.session.setUser(me);
    if (changed) this.forbiddenGapMs = this.config.userMinGapMs;
    else if (trigger === 'forbidden') this.forbiddenGapMs = this.config.userMaxAgeMs;
  }

  /** Recusa de acesso (e não a da passkey): a tela pode estar oferecendo o que a conta perdeu; relê a conta uma vez. */
  private noteDenied(error: unknown, options: AuthorizedOptions): void {
    if (options.rereadOnForbidden === false) return;
    const problem = problemOf(error);
    if (problem && isPermissionDenied(problem)) void this.refreshUser('forbidden');
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
