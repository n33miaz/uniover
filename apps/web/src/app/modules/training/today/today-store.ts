import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { AccountScope } from '../../../core/session/account-scope';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { CatalogRepository } from '../data/catalog/catalog-repository';
import type { LocalExercise } from '../data/catalog/exercise';
import { ProgressRepository, type WeekSummary } from '../data/progress/progress-repository';
import type { LocalRoutine } from '../data/routines/routine';
import { RoutineRepository } from '../data/routines/routine-repository';
import type { LocalSession } from '../data/sessions/session';
import { SessionRepository } from '../data/sessions/session-repository';
import { TrainingSync } from '../data/sync/training-sync';
import { summarizeLastSets } from '../exercises/last-set';
import {
  addDays,
  civilDateOf,
  dateKey,
  dateKeyOf,
  deviceTimeZone,
  startOfDay,
} from '../domain/progress/calendar';
import { type DayPlan, planForDay } from '../domain/routines/week-plan';
import { type RoutineEntry, buildRoutineEntries } from '../routines/routine-stats';
import { awaitingFirstPull } from '../shell/first-pull';
import { coalesced, quiet } from './coalesce';
import { SwapStore } from './swap-store';

/** Depois de quanto tempo um treino aberto em outro aparelho pode ser dado como esquecido (proposta nossa, 12 horas). */
/** Chave do aparelho onde a conta guarda que dispensou a sugestão de programa (por conta). */
export function programDismissedKey(accountId: string): string {
  return `uniover.training.program-dismissed.${accountId}`;
}

/** Chave diária: ao seguir sem programa, a pergunta não interrompe outro início no mesmo dia. */
export function programStartDismissedKey(accountId: string, day: string): string {
  return `uniover.training.program-start-dismissed.${accountId}.${day}`;
}

export const FORGOTTEN_AFTER_MS = 12 * 60 * 60 * 1000;

/** Uma linha da rotina do dia, como a tela de Hoje a mostra. */
export interface RoutineLine {
  readonly key: string;
  /** `null` quando o exercício já não está no catálogo. */
  readonly name: string | null;
  readonly sets: number;
  readonly repMin: number;
  readonly repMax: number;
  readonly superset: boolean;
  /** "40 kg × 10": a melhor série da última vez; `null` sem registro. */
  readonly last: string | null;
  /** Carga que a sugestão pede quando ela SOBE em relação à última vez; `null` quando a carga fica. */
  readonly tryKg: number | null;
}

/** Treino aberto em outro aparelho, com há quanto tempo. */
export interface OtherDevice {
  readonly session: LocalSession;
  readonly ageMs: number;
  /** Passou do limite: a tela oferece encerrar o treino esquecido. */
  readonly forgotten: boolean;
}

/** O treino encerrado mais recente antes de hoje, para o atalho "Treino de Ontem" de Hoje. */
export interface PreviousWorkout {
  readonly sessionId: string;
  /** O dia em que começou (`AAAA-MM-DD`, no fuso do aparelho). */
  readonly dayKey: string;
  /** Foi ontem: o atalho diz "Treino de Ontem"; sendo mais antigo, diz "Último Treino" com a data. */
  readonly yesterday: boolean;
}

/** O que acontece ao pedir para iniciar um treino. */
export type StartOutcome = 'started' | 'resumed' | 'blocked' | 'storage-full' | 'program-choice';

const SESSION_URL = /\/sessions\/([^/?]+)(?:\/sets\/([^/?]+))?$/;

/**
 * O que a aba Hoje sabe, lido do banco local (nunca da rede): o treino aberto, o treino aberto em outro aparelho, as
 * rotinas e a do dia, o resumo da semana e o que a fila de envio guarda dos treinos. A tela de Hoje, o treino ao vivo e o
 * resumo leem daqui; quem grava série é o `LiveStore`.
 */
@Injectable()
export class TodayStore {
  private readonly sessions = inject(SessionRepository);
  private readonly routines = inject(RoutineRepository);
  private readonly catalog = inject(CatalogRepository);
  private readonly progress = inject(ProgressRepository);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);
  private readonly swaps = inject(SwapStore);
  private readonly account = inject(AccountScope);
  private readonly storage = inject(DOCUMENT).defaultView?.localStorage ?? null;

  // O que decide qual visão aparece.
  readonly ready = signal(false);
  readonly active = signal<LocalSession | undefined>(undefined);
  readonly otherDevice = signal<OtherDevice | undefined>(undefined);
  /** Quantos exercícios o catálogo local tem; `null` enquanto não se leu. */
  readonly catalogCount = signal<number | null>(null);

  // Hoje.
  readonly entries = signal<readonly RoutineEntry[]>([]);
  readonly homeReady = signal(false);
  readonly week = signal<WeekSummary | null>(null);
  /** O treino de ontem (ou o último antes de hoje); `null` quando ainda não há nenhum para resumir. */
  readonly previousWorkout = signal<PreviousWorkout | null>(null);
  readonly lines = signal<readonly RoutineLine[]>([]);
  readonly chosenRoutineId = signal<string | null>(null);
  /** A ficha do programa da semana para hoje, calculada no aparelho (vale sem rede). */
  readonly plan = signal<DayPlan>({ routineId: null, resting: false });
  /** Dia de descanso do programa: a tela oferece só o treino manual ou outra ficha. */
  readonly resting = computed(() => this.plan().resting);
  /** O programa da semana ativo da conta (a escolha gravada); `null` enquanto ninguém escolheu. */
  readonly programId = signal<string | null>(null);
  /** A pessoa dispensou a sugestão de programa neste aparelho (só vale com fichas livres; sem fichas ela fica). */
  readonly suggestionDismissed = signal(false);
  /** A pessoa preferiu seguir sem programa neste dia; amanhã a escolha volta a ficar disponível. */
  readonly startSuggestionDismissed = signal(false);
  /**
   * Sugerir o programa da semana: a conta ainda não tem programa ativo, não há treino aberto e a sugestão não foi
   * dispensada. Escolhido o programa, ela some sozinha e Hoje abre no treino do dia.
   */
  readonly suggestProgram = computed(
    () =>
      this.homeReady() &&
      this.programId() === null &&
      this.active() === undefined &&
      this.otherDevice() === undefined &&
      (this.entries().length === 0 || !this.suggestionDismissed()),
  );
  /** Antes de abrir uma sessão nova, dá outra chance de escolher um programa semanal. */
  readonly needsProgramChoice = computed(
    () =>
      this.homeReady() &&
      this.programId() === null &&
      this.active() === undefined &&
      this.otherDevice() === undefined &&
      !this.startSuggestionDismissed(),
  );
  /** O nome da rotina em andamento (para o cartão "Continuar treino"). */
  readonly activeRoutine = signal<LocalRoutine | undefined>(undefined);
  readonly activeProgress = signal<{ readonly done: number; readonly planned: number } | null>(
    null,
  );

  // A fila de envio, do ponto de vista dos treinos.
  private readonly pendingSetsBySession = signal<ReadonlyMap<string, number>>(new Map());
  /** Treinos com algum pedido recusado pelo servidor. */
  readonly failedSessionIds = signal<readonly string[]>([]);

  /** A rotina que o cartão mostra: a escolhida, ou a próxima da sequência, ou a primeira. */
  readonly selected = computed<RoutineEntry | undefined>(() => {
    const entries = this.entries();
    const chosen = this.chosenRoutineId();
    if (chosen !== null) return entries.find((entry) => entry.routine.id === chosen);
    const plan = this.plan();
    if (plan.resting) return undefined;
    return (
      entries.find((entry) => entry.routine.id === plan.routineId) ??
      entries.find((entry) => entry.next) ??
      entries[0]
    );
  });

  /** Dia (ano-mês-dia local) da última leitura: ao virar, a escolha manual do dia anterior é esquecida. */
  private lastDay = '';

  /** Sem rede ainda trouxe nada: a lista vazia pode ser só falta de primeira passada. */
  readonly downloading = computed(
    () => this.sync.pulling() || awaitingFirstPull(this.sync, this.connectivity),
  );

  /** O treino aberto deste aparelho tem quantas séries aguardando envio. */
  readonly awaitingSets = computed(() => {
    const id = this.active()?.id;
    return id === undefined ? 0 : (this.pendingSetsBySession().get(id) ?? 0);
  });

  private linesTicket = 0;

  constructor() {
    effect(() => {
      this.sessions.revision();
      untracked(() => void this.loadCore());
    });
    effect(() => {
      this.catalog.revision();
      untracked(() => void this.loadCatalogCount());
    });
    effect(() => {
      this.queue.pendingCount();
      this.queue.failedCount();
      untracked(() => void this.readQueue());
    });
    effect(() => {
      const entry = this.selected();
      untracked(() => void this.loadLines(entry));
    });
  }

  /** Quantas séries de um treino ainda esperam envio (uma por série, mesmo que ela tenha sido editada). */
  awaitingSetsOf(sessionId: string): number {
    return this.pendingSetsBySession().get(sessionId) ?? 0;
  }

  /** Lê o treino aberto, deste e de outro aparelho (uma leitura por vez; quem espera recebe o estado já atualizado). */
  readonly loadCore = coalesced(
    quiet(
      () => this.readCore(),
      () => this.ready.set(true),
    ),
  );

  /** Lê as rotinas, a do dia e o resumo da semana (uma leitura por vez). */
  readonly loadHome = coalesced(
    quiet(
      () => this.readHome(),
      () => this.homeReady.set(true),
    ),
  );

  private async readCore(): Promise<void> {
    const [active, elsewhere] = await Promise.all([
      this.sessions.activeSession(),
      this.sessions.openSessionsElsewhere(),
    ]);

    const other = elsewhere[0];
    const ageMs = other === undefined ? 0 : Math.max(0, this.runtime.now() - other.startedAt);
    this.active.set(active);
    this.otherDevice.set(
      other === undefined
        ? undefined
        : { session: other, ageMs, forgotten: ageMs >= FORGOTTEN_AFTER_MS },
    );
    this.ready.set(true);

    // O cartão "Continuar treino" diz de que rotina é e quanto já foi feito.
    if (active === undefined) {
      this.activeRoutine.set(undefined);
      this.activeProgress.set(null);
      return;
    }
    const [routine, sets] = await Promise.all([
      active.routineId === null ? undefined : this.routines.get(active.routineId),
      this.sessions.setsOfSession(active.id),
    ]);
    this.activeRoutine.set(routine);
    this.activeProgress.set({
      done: sets.filter((set) => set.setType !== 'warmup').length,
      planned: routine?.items.reduce((sum, item) => sum + item.targetSets, 0) ?? 0,
    });
  }

  /** Quantos exercícios o catálogo local tem (o treino não começa sem catálogo). */
  readonly loadCatalogCount = quiet(
    async () => this.catalogCount.set(await this.catalog.count()),
    () => this.catalogCount.set(0),
  );

  private async readHome(): Promise<void> {
    const [all, active, sessions, week, programId] = await Promise.all([
      this.routines.all(),
      this.routines.list(),
      this.sessions.sessionsBetween(0, Number.MAX_SAFE_INTEGER),
      this.progress.weekSummary(),
      this.routines.activeProgramId(),
    ]);
    const entries = buildRoutineEntries(all, active, sessions);
    const now = this.runtime.now();
    const previous = await this.findPreviousWorkout(sessions, now);
    const day = new Date(now).toDateString();
    if (day !== this.lastDay) {
      // Virou o dia (o app instalado volta do segundo plano na terça): a ficha do dia vale de novo.
      this.lastDay = day;
      this.chosenRoutineId.set(null);
    }
    this.programId.set(programId);
    this.suggestionDismissed.set(this.readDismissed());
    this.startSuggestionDismissed.set(this.readStartDismissed(day));
    this.plan.set(planForDay(all, sessions, now, programId));
    this.entries.set(entries);
    this.week.set(week);
    this.previousWorkout.set(previous);
    this.homeReady.set(true);
  }

  /**
   * O treino encerrado mais recente que começou antes de hoje e tem ao menos uma série de trabalho (o mesmo critério do
   * calendário: sem série não há resumo para abrir). O dia é o do fuso do aparelho, nunca o de UTC. Percorre do mais novo
   * ao mais antigo até achar um válido, por mais sessões vazias que haja no caminho. É um atalho: se o banco falhar ao
   * ler as séries, ele some (`null`), sem derrubar a leitura das rotinas, da ficha do dia e do resumo da semana.
   */
  private async findPreviousWorkout(
    sessions: readonly LocalSession[],
    now: number,
  ): Promise<PreviousWorkout | null> {
    const zone = deviceTimeZone();
    const today = civilDateOf(now, zone);
    const todayStart = startOfDay(today, zone);
    const yesterdayKey = dateKeyOf(addDays(today, -1));
    const earlier = sessions
      .filter(
        (session) =>
          session.finishedAt !== null &&
          session.deletedAt === null &&
          session.startedAt < todayStart,
      )
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const session of earlier) {
      try {
        const sets = await this.sessions.setsOfSession(session.id);
        if (sets.some((set) => set.setType !== 'warmup')) {
          const dayKey = dateKey(session.startedAt, zone);
          return { sessionId: session.id, dayKey, yesterday: dayKey === yesterdayKey };
        }
      } catch {
        // Banco local sem resposta: sem atalho, e a tela de Hoje segue de pé com o resto.
        return null;
      }
    }
    return null;
  }

  /** Dispensa a sugestão de programa neste aparelho (quem já tem fichas livres pode seguir com elas). */
  dismissSuggestion(): void {
    this.suggestionDismissed.set(true);
    const id = this.account.id();
    if (id === null) return;
    try {
      this.storage?.setItem(programDismissedKey(id), '1');
    } catch {
      // Sem armazenamento (janela privada): a sugestão volta na próxima abertura.
    }
  }

  /** Guarda só até o fim do dia a opção de começar sem escolher um programa semanal. */
  dismissProgramBeforeStart(): void {
    this.startSuggestionDismissed.set(true);
    const id = this.account.id();
    if (id === null) return;
    try {
      this.storage?.setItem(programStartDismissedKey(id, this.dayKey()), '1');
    } catch {
      // Sem armazenamento (janela privada): a pergunta pode voltar depois de recarregar.
    }
  }

  private readDismissed(): boolean {
    const id = this.account.id();
    if (id === null) return false;
    try {
      return this.storage?.getItem(programDismissedKey(id)) === '1';
    } catch {
      return this.suggestionDismissed();
    }
  }

  private readStartDismissed(day: string): boolean {
    const id = this.account.id();
    if (id === null) return false;
    try {
      return this.storage?.getItem(programStartDismissedKey(id, day)) === '1';
    } catch {
      return this.startSuggestionDismissed();
    }
  }

  private dayKey(): string {
    return new Date(this.runtime.now()).toDateString();
  }

  /** Escolhe outra rotina para o cartão do dia (só vale até a tela sair). */
  chooseRoutine(routineId: string): void {
    this.chosenRoutineId.set(routineId);
  }

  /** Abre o treino de uma rotina (ou o treino livre, sem rotina). */
  async start(routineId: string | null): Promise<StartOutcome> {
    if (this.needsProgramChoice()) return 'program-choice';
    const result = await this.sessions.start(routineId);
    switch (result.status) {
      case 'started':
        // Um treino novo nunca herda as trocas do anterior.
        this.swaps.clear();
        return 'started';
      case 'already-active':
        return 'resumed';
      case 'open-elsewhere':
        return 'blocked';
      case 'storage-full':
        return 'storage-full';
    }
  }

  /** Encerra o treino que ficou aberto em outro aparelho. Devolve se deu certo. */
  async closeForgotten(sessionId: string): Promise<boolean> {
    const result = await this.sessions.closeElsewhere(sessionId);
    await this.loadCore();
    return result.status === 'saved';
  }

  /** Reenvia os treinos que o servidor recusou (pedidos novos, com chaves novas). */
  async resendFailed(): Promise<boolean> {
    let sent = true;
    for (const id of this.failedSessionIds()) {
      const result = await this.sessions.resendSession(id);
      if (result.status !== 'queued') sent = false;
    }
    await this.readQueue();
    return sent;
  }

  /** Lê o que a fila guarda dos treinos: séries esperando envio e treinos recusados. */
  readonly readQueue = quiet(() => this.scanQueue());

  private async scanQueue(): Promise<void> {
    const items = await this.queue.items();
    const pending = new Map<string, Set<string>>();
    const failed = new Set<string>();
    for (const item of items) {
      const match = SESSION_URL.exec(item.url);
      if (match === null) continue;
      const [, sessionId, setId] = match;
      if (item.status === 'failed') failed.add(decodeURIComponent(sessionId));
      else if (setId !== undefined) {
        const key = decodeURIComponent(sessionId);
        pending.set(key, (pending.get(key) ?? new Set()).add(decodeURIComponent(setId)));
      }
    }
    this.pendingSetsBySession.set(new Map([...pending].map(([id, ids]) => [id, ids.size])));
    this.failedSessionIds.set([...failed]);
  }

  private async loadLines(entry: RoutineEntry | undefined): Promise<void> {
    const ticket = ++this.linesTicket;
    try {
      await this.readLines(entry, ticket);
    } catch {
      // Sem banco local a rotina fica sem as linhas de "última vez": o cartão do dia segue valendo.
      if (ticket === this.linesTicket) this.lines.set([]);
    }
  }

  private async readLines(entry: RoutineEntry | undefined, ticket: number): Promise<void> {
    if (entry === undefined) {
      this.lines.set([]);
      return;
    }
    const lines: RoutineLine[] = [];
    for (const item of entry.routine.items) {
      const exercise: LocalExercise | undefined = await this.catalog.get(item.exerciseId);
      const [last, suggestion] = await Promise.all([
        this.sessions.lastPerformance(item.exerciseId),
        this.progress.lastLoadSuggestion(item),
      ]);
      const lastText = last && exercise ? summarizeLastSets(last.sets, exercise.recordType) : null;
      const lastMax = Math.max(0, ...(last?.sets ?? []).map((set) => set.weightKg ?? 0));
      lines.push({
        key: item.id,
        name: exercise?.name ?? null,
        sets: item.targetSets,
        repMin: item.repMin,
        repMax: item.repMax,
        superset: item.supersetGroup !== null,
        last: lastText,
        tryKg:
          suggestion.weightKg !== null && suggestion.weightKg > lastMax
            ? suggestion.weightKg
            : null,
      });
    }
    if (ticket === this.linesTicket) this.lines.set(lines);
  }
}
