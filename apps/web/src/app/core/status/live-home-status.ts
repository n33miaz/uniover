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
import { SessionState } from '../session/session-state';
import { StreamEvent, StreamService } from '../sse/stream.service';
import { ClockService } from '../time/clock.service';
import {
  AgentAlertNote,
  AgentState,
  HomeStatus,
  HomeStatusPort,
  WatcherState,
} from './home-status.port';

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
/** Avisos de queda do computador, ainda não vistos pelo dono. */
const ALERTS_PATH = `${APP_CONFIG.apiBase}/v1/devices/agent-alerts`;
/** Fluxo de eventos da TV; o cookie de bilhete do `StreamService` é a credencial, nunca um token na URL. */
const EVENTS_PATH = `${APP_CONFIG.apiBase}/v1/tv/events`;
const STATE_EVENT = 'tv.state';
const WATCHDOG_EVENT = 'tv.watchdog';

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

/** O aviso mais recente que vale: uma queda em aberto vence uma volta já anotada. Lista vazia ou fora do formato = sem aviso. */
function alertOf(body: unknown): AgentAlertNote | null {
  if (!Array.isArray(body)) return null;
  const items = body.filter(
    (item): item is { agentName: string; recoveredAt: string | null } =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as { agentName?: unknown }).agentName === 'string',
  );
  const down = items.find((item) => !item.recoveredAt);
  const shown = down ?? items[0];
  return shown ? { name: shown.agentName, recovered: !down } : null;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
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
 * a aba estiver visível, houver rede e a sessão for a do dono, lê o estado na hora, de novo a cada `pollMs` e mantém
 * o fluxo aberto; qualquer condição que falte cancela a leitura em voo, o intervalo e o fluxo. O Render dorme sem
 * tráfego, então uma conexão aberta fora da tela seria a única coisa a mantê-lo acordado.
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

  private readonly watchers = signal(0);
  private readonly visible = signal(this.doc.visibilityState !== 'hidden');
  private readonly agent = signal<AgentState>('unknown');
  private readonly serviceDown = signal(false);
  private readonly verdict = signal<Verdict | null>(null);
  private readonly agentAlert = signal<AgentAlertNote | null>(null);

  /**
   * Só o dono confirmado consulta: sem sessão, com a sessão ainda a confirmar ou como convidado não há chamada
   * nenhuma. O papel precisa ser conhecido (e ser o de dono): papel desconhecido não basta.
   */
  private readonly active = computed(
    () =>
      this.watchers() > 0 &&
      this.visible() &&
      this.connectivity.online() &&
      this.session.isAuthenticated() &&
      this.session.role() === 'owner',
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
    agentAlert: this.agentAlert(),
  }));

  constructor() {
    super();

    const onVisibility = () => this.visible.set(this.doc.visibilityState !== 'hidden');
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() =>
      this.doc.removeEventListener('visibilitychange', onVisibility),
    );

    // Cada vez que as condições mudam, o que estava em andamento é cancelado e, se ainda valem, recomeça.
    effect((onCleanup) => {
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
            next: (body) => this.onState(body),
            error: (error: unknown) => this.onFailure(error),
          }),
      );
    };

    // O aviso de queda é um acréscimo: falhar em lê-lo não muda nada (nem vira "serviço fora do ar").
    const refreshAlert = () =>
      work.add(
        this.http.get<unknown>(ALERTS_PATH).subscribe({
          next: (body) => this.agentAlert.set(alertOf(body)),
          error: () => undefined,
        }),
      );

    refresh();
    refreshAlert();
    const timer = setInterval(() => {
      refresh();
      refreshAlert();
    }, this.config.pollMs);
    work.add(() => clearInterval(timer));
    work.add(
      this.stream.open(EVENTS_PATH, [STATE_EVENT, WATCHDOG_EVENT]).subscribe((event) => {
        this.onEvent(event);
      }),
    );
    return () => work.unsubscribe();
  }

  private onState(body: unknown): void {
    // A API respondeu, seja qual for o conteúdo.
    this.serviceDown.set(false);
    this.agent.set(agentOf(body));
  }

  /**
   * Só vira "serviço fora do ar" quando a API não respondeu: sem resposta com a rede do aparelho de pé, ou o 502/503/504
   * do proxy do servidor dormindo ou caído. Sem internet no aparelho, o erro não diz nada sobre a API e fica de fora. Qualquer
   * outra resposta (401, 404, 429...) prova que a API está de pé: não há dado novo, mas também não há queda.
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
    }
  }

  private onEvent(event: StreamEvent): void {
    // Um evento chegando prova que a API está de pé.
    this.serviceDown.set(false);
    const body = parseJson(event.data);
    switch (event.type) {
      case STATE_EVENT: {
        const agent = agentOf(body);
        if (agent !== 'unknown') this.agent.set(agent);
        return;
      }
      case WATCHDOG_EVENT: {
        const state = verdictOf(body);
        if (state) this.verdict.set({ state, receivedAt: Date.now() });
        return;
      }
    }
  }

  private forget(): void {
    this.agent.set('unknown');
    this.serviceDown.set(false);
    this.verdict.set(null);
    this.agentAlert.set(null);
  }
}
