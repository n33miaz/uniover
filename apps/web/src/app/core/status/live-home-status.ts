import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Subscription, finalize } from 'rxjs';
import type { TvWatchdogV1Body } from '../api/generated/agent';
import type { components } from '../api/generated/schema';
import { problemOf } from '../auth/api-problem';
import { APP_CONFIG } from '../config/app-config';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { canUseModule } from '../auth/guest-home';
import { SessionState } from '../session/session-state';
import { StreamEvent, StreamService } from '../sse/stream.service';
import { ClockService } from '../time/clock.service';
import { AgentState, HomeStatus, HomeStatusPort, WatcherState } from './home-status.port';

export interface HomeStatusConfig {
  /** Intervalo entre leituras do estado enquanto a Início está à vista e a aba visível. */
  readonly pollMs: number;
  /**
   * Quanto tempo o que o vigia contou continua valendo. Ele só fala quando algo acontece (com tudo certo fica em
   * silêncio) e só se escuta com a Início aberta: passado este prazo, o aviso pode já ter sido resolvido sem que
   * ninguém estivesse ouvindo, e o selo volta a "sem dados" em vez de afirmar o que não se sabe.
   */
  readonly watchdogTtlMs: number;
}

export const HOME_STATUS_CONFIG = new InjectionToken<HomeStatusConfig>('HOME_STATUS_CONFIG', {
  providedIn: 'root',
  factory: () => ({ pollMs: 30_000, watchdogTtlMs: 30 * 60_000 }),
});

const STATE_PATH = `${APP_CONFIG.apiBase}/v1/tv/state`;
/** Fluxo de eventos da TV; o cookie de bilhete do `StreamService` é a credencial, nunca um token na URL. */
const EVENTS_PATH = `${APP_CONFIG.apiBase}/v1/tv/events`;
const STATE_EVENT = 'tv.state';
const WATCHDOG_EVENT = 'tv.watchdog';
/**
 * O último estado do agente é lembrado por conta: o estado é o do agente DA TV daquela conta, então uma conta nunca pode
 * pintar a Início da outra no mesmo navegador. "none" lembra que a conta não tem agente (a Início já abre sem ponto).
 * A chave antiga (uma só para todos) é apagada na partida.
 */
const AGENT_CACHE_PREFIX = 'uniover.home.agent.v2.';
const LEGACY_AGENT_CACHE_KEY = 'uniover.home.agent.v1';
const SLOW_RESPONSE_MS = 400;
/** A espera mostrada nunca passa disto: sem resposta até aqui, o brilho para e a tela segue com o que há (sem laço). */
const MAX_LOADING_MS = 8_000;

type TvStateDto = components['schemas']['TvState'];

/** O que o vigia contou por último e quando a Início soube. */
interface Verdict {
  readonly state: Exclude<WatcherState, 'unknown'>;
  readonly receivedAt: number;
}

/** Só `agentOnline` interessa à Início; qualquer corpo sem esse campo booleano vale como "sem dados". */
function agentOf(body: unknown): AgentState {
  if (!body || typeof body !== 'object') return 'unknown';
  const online = (body as Partial<TvStateDto>).agentOnline;
  if (typeof online !== 'boolean') return 'unknown';
  return online ? 'online' : 'offline';
}

/** A TV da conta tem um computador vinculado? Só `false` explícito diz que não: uma resposta sem o campo vale como "sim". */
function linkedOf(body: unknown): boolean {
  return !(body && typeof body === 'object' && (body as Partial<TvStateDto>).agentLinked === false);
}

/**
 * Leitura do evento do vigia. Só decide quando há evidência: erro ou reparo que falhou é aviso; reparo ou
 * recuperação concluídos é "em ordem". Os demais (porta fechada, reparo começando, ADB fora) são passos de uma
 * história que ainda termina em um dos dois, então não mudam a conclusão anterior.
 */
function verdictOf(body: unknown): Verdict['state'] | null {
  if (!body || typeof body !== 'object') return null;
  const { kind, severity } = body as Partial<Pick<TvWatchdogV1Body, 'kind' | 'severity'>>;
  if (severity === 'error' || kind === 'repair_failed') return 'alert';
  if (kind === 'repaired' || kind === 'recovered') return 'ok';
  return null;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

type CachedAgent = Exclude<AgentState, 'unknown'> | 'none';

/** Só estados afirmativos entram no cache (ou "none"); valor inválido não pode pintar uma casa que não conhecemos. */
function readCachedAgent(storage: Storage | null, account: string | null): CachedAgent | null {
  if (account === null) return null;
  try {
    const value = storage?.getItem(AGENT_CACHE_PREFIX + account);
    return value === 'online' || value === 'offline' || value === 'none' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Estado real da casa para a Início: o agente (ligado ou desligado) vem de `GET /api/v1/tv/state`, que já cruza a
 * última leitura com a presença do agente no servidor, e o vigia vem do fluxo `tv.watchdog`, a única porta pela qual
 * ele aparece (nenhuma rota lê os eventos dele e o instantâneo do fluxo só traz o estado e os atalhos).
 *
 * Nada roda em segundo plano: a Início chama `watch()` ao aparecer e solta ao sair. Enquanto houver quem acompanhe,
 * a aba estiver visível, houver rede e a sessão for a do dono ou a de um convidado com a TV (`module:tv`, lista de
 * permissões conhecida), lê o estado na hora, de novo a cada `pollMs` e mantém o fluxo aberto; qualquer condição que
 * falte cancela a leitura em voo, o intervalo e o fluxo. O Render dorme sem tráfego, então uma conexão aberta fora da
 * tela seria a única coisa a mantê-lo acordado.
 *
 * O servidor responde com o agente da TV que a conta enxerga, então cada um vê o agente DELE (o dono o do dono, o convidado
 * o do convidado), e diz também se a conta tem algum agente vinculado: sem ele a Início não mostra ponto algum. O aviso de
 * queda de outros computadores não é lido aqui. Ao trocar de conta, tudo o que se sabia (estado, vínculo, lembrança) é
 * descartado antes da primeira leitura da nova.
 */
@Injectable({ providedIn: 'root' })
export class LiveHomeStatus extends HomeStatusPort {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionState);
  private readonly connectivity = inject(ConnectivityService);
  private readonly stream = inject(StreamService);
  private readonly clock = inject(ClockService);
  private readonly config = inject(HOME_STATUS_CONFIG);
  private readonly doc = inject(DOCUMENT);
  private readonly storage = this.openStorage();
  /** A conta a quem pertence o que está em memória; `undefined` até a primeira adoção. */
  private account: string | null | undefined = undefined;
  /** O que se lembrava do agente desta conta ao adotá-la: com ele a Início não mostra espera. */
  private cachedAgent: CachedAgent | null = null;

  private readonly watchers = signal(0);
  private readonly visible = signal(this.doc.visibilityState !== 'hidden');
  private readonly agent = signal<AgentState>('unknown');
  readonly loading = signal(false);
  private readonly serviceDown = signal(false);
  private readonly verdict = signal<Verdict | null>(null);
  /** A TV desta conta tem um agente vinculado? `null` enquanto não se sabe. */
  private readonly linked = signal<boolean | null>(null);

  /**
   * Quem pode consultar: o dono confirmado, ou o convidado cuja lista de permissões (conhecida) traz a TV. Sem sessão,
   * com a sessão ainda a confirmar, papel desconhecido, convidado sem a TV ou sem lista conhecida não há chamada nenhuma.
   */
  private readonly allowed = computed(() => {
    if (!this.session.isAuthenticated()) return false;
    const role = this.session.role();
    if (role === 'owner') return true;
    const permissions = this.session.knownPermissions();
    return role === 'guest' && permissions !== null && canUseModule('guest', permissions, 'tv');
  });

  private readonly active = computed(
    () => this.watchers() > 0 && this.visible() && this.connectivity.online() && this.allowed(),
  );

  /** O vigia roda dentro do agente: sem agente ligado não há o que dizer, e a evidência velha deixa de valer. */
  private readonly watcher = computed<WatcherState>(() => {
    const verdict = this.verdict();
    if (!verdict || this.agent() !== 'online') return 'unknown';
    // Ler o relógio (que avança a cada 30 s) faz o prazo vencer sozinho, sem um temporizador próprio.
    const age = this.clock.now().getTime() - verdict.receivedAt;
    return age <= this.config.watchdogTtlMs ? verdict.state : 'unknown';
  });

  readonly status = computed<HomeStatus>(() => ({
    userName: this.session.user()?.displayName ?? null,
    agent: this.agent(),
    watcher: this.watcher(),
    serviceDown: this.serviceDown(),
    agentLinked: this.linked(),
  }));

  constructor() {
    super();

    const onVisibility = () => this.visible.set(this.doc.visibilityState !== 'hidden');
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() =>
      this.doc.removeEventListener('visibilitychange', onVisibility),
    );

    // O que se lembra da conta atual já é o ponto de partida na criação: a Início pinta sem esperar a rede.
    this.adopt(this.session.sessionAccountId());
    try {
      this.storage?.removeItem(LEGACY_AGENT_CACHE_KEY);
    } catch {
      // Armazenamento bloqueado: a chave antiga só deixa de ser lida, nada mais depende dela.
    }

    // Cada vez que as condições mudam, o que estava em andamento é cancelado e, se ainda valem, recomeça. A conta vem
    // primeiro: ao trocar de conta (mesmo sem passar por "sair") o estado da anterior é descartado antes da nova leitura.
    effect((onCleanup) => {
      const account = this.session.sessionAccountId();
      untracked(() => this.adopt(account));
      if (!this.active()) return;
      onCleanup(untracked(() => this.run()));
    });

    // Sessão encerrada (sair da conta, refresh recusado): esquece o que sabia da casa.
    effect(() => {
      if (this.session.status() === 'anonymous') untracked(() => this.forget());
    });
  }

  watch(): () => void {
    this.visible.set(this.doc.visibilityState !== 'hidden');
    this.watchers.update((count) => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers.update((count) => Math.max(0, count - 1));
    };
  }

  /** Começa a consultar e a ouvir; devolve o que cancela tudo (a leitura em voo, o intervalo e o fluxo). */
  private run(): () => void {
    const work = new Subscription();
    let pending = false;
    let answered = false;
    let giveUp: number | undefined;
    const slowResponse = window.setTimeout(() => {
      // Sem estado lembrado, sem estado em mãos e sem saber que a conta não tem agente: só então vale mostrar a espera.
      if (answered || this.cachedAgent !== null || this.agent() !== 'unknown') return;
      if (this.linked() === false) return;
      this.loading.set(true);
      giveUp = window.setTimeout(() => this.loading.set(false), MAX_LOADING_MS - SLOW_RESPONSE_MS);
    }, SLOW_RESPONSE_MS);
    const stopWaiting = () => {
      window.clearTimeout(slowResponse);
      window.clearTimeout(giveUp);
      this.loading.set(false);
    };
    const settleInitial = () => {
      answered = true;
      stopWaiting();
    };

    const refresh = () => {
      // A leitura anterior ainda não voltou (servidor acordando): não empilha outra por cima.
      if (pending) return;
      pending = true;
      work.add(
        this.http
          .get<TvStateDto>(STATE_PATH)
          .pipe(
            finalize(() => {
              pending = false;
            }),
          )
          .subscribe({
            next: (body) => {
              this.onState(body);
              settleInitial();
            },
            error: (error: unknown) => {
              this.onFailure(error);
              settleInitial();
            },
          }),
      );
    };

    refresh();
    const timer = setInterval(refresh, this.config.pollMs);
    work.add(() => clearInterval(timer));
    work.add(
      this.stream.open(EVENTS_PATH, [STATE_EVENT, WATCHDOG_EVENT]).subscribe((event) => {
        this.onEvent(event);
      }),
    );
    return () => {
      stopWaiting();
      work.unsubscribe();
    };
  }

  private onState(body: unknown): void {
    // A API respondeu, seja qual for o conteúdo.
    this.serviceDown.set(false);
    this.applyAgent(agentOf(body), linkedOf(body));
  }

  /** Aplica o que a API disse do agente da TV desta conta; sem agente vinculado não há estado a mostrar. */
  private applyAgent(agent: AgentState, linked: boolean): void {
    if (!linked) {
      this.linked.set(false);
      this.agent.set('unknown');
      this.cache('none');
      return;
    }
    if (agent !== 'unknown') this.linked.set(true);
    this.agent.set(agent);
    this.cache(agent);
  }

  /**
   * Só vira "serviço fora do ar" quando a API não respondeu: sem resposta com a rede do aparelho de pé, ou o 502/503/504
   * do proxy do servidor dormindo ou caído. Sem internet no aparelho, o erro não diz nada sobre a API e fica de fora. Qualquer
   * outra resposta (401, 404, 429...) prova que a API está de pé: não há queda. Com 403 ou 404 a conta não enxerga TV nenhuma
   * (sem agente dela, logo sem ponto); com 401 o estado lembrado é descartado; nos demais, o último estado continua valendo.
   */
  private onFailure(error: unknown): void {
    const problem = problemOf(error);
    if (!problem) return;
    const unanswered = problem.isNetwork
      ? this.connectivity.online()
      : problem.status >= 502 && problem.status <= 504;
    if (unanswered) {
      this.serviceDown.set(true);
      // Sem falar com a API não dá para afirmar nada sobre o agente.
      this.agent.set('unknown');
    } else if (!problem.isNetwork) {
      this.serviceDown.set(false);
      // A API respondeu que esta conta não tem (ou deixou de ter) a TV: o que se lembrava do agente já não vale, e
      // continuar a mostrá-lo afirmaria algo sobre uma TV que a conta não enxerga.
      if (problem.status === 403 || problem.status === 404) {
        this.applyAgent('unknown', false);
      } else if (problem.status === 401) {
        this.agent.set('unknown');
        this.linked.set(null);
        this.cachedAgent = null;
        this.forgetCachedAgent();
      }
    }
  }

  private onEvent(event: StreamEvent): void {
    // Um evento chegando prova que a API está de pé.
    this.serviceDown.set(false);
    const body = parseJson(event.data);
    switch (event.type) {
      case STATE_EVENT: {
        const agent = agentOf(body);
        if (agent !== 'unknown') this.applyAgent(agent, linkedOf(body));
        return;
      }
      case WATCHDOG_EVENT: {
        const state = verdictOf(body);
        if (state) this.verdict.set({ state, receivedAt: Date.now() });
        return;
      }
    }
  }

  /** Passa para a conta dada: o que era da anterior não vale para esta, e a lembrança desta (se houver) vira o ponto de partida. */
  private adopt(account: string | null): void {
    if (this.account === account) return;
    this.account = account;
    this.cachedAgent = readCachedAgent(this.storage, account);
    this.agent.set(
      this.cachedAgent === null || this.cachedAgent === 'none' ? 'unknown' : this.cachedAgent,
    );
    this.linked.set(this.cachedAgent === 'none' ? false : null);
    this.serviceDown.set(false);
    this.verdict.set(null);
    this.loading.set(false);
  }

  private forget(): void {
    this.account = null;
    this.cachedAgent = null;
    this.agent.set('unknown');
    this.linked.set(null);
    this.serviceDown.set(false);
    this.verdict.set(null);
    this.loading.set(false);
  }

  private forgetCachedAgent(): void {
    try {
      if (this.account) this.storage?.removeItem(AGENT_CACHE_PREFIX + this.account);
    } catch {
      // Armazenamento bloqueado: nada a apagar.
    }
  }

  private openStorage(): Storage | null {
    try {
      return this.doc.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private cache(agent: AgentState | 'none'): void {
    if (agent === 'unknown') return;
    try {
      if (this.account) this.storage?.setItem(AGENT_CACHE_PREFIX + this.account, agent);
    } catch {
      // Armazenamento pode estar bloqueado: o estado atual ainda continua útil nesta visita.
    }
  }
}
