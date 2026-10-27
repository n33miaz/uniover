import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { TrainingSync } from '../data/sync/training-sync';
import { CatalogRepository } from '../data/catalog/catalog-repository';
import type { LocalExercise } from '../data/catalog/exercise';
import { ProgressRepository } from '../data/progress/progress-repository';
import type { LocalRoutine } from '../data/routines/routine';
import { RoutineRepository } from '../data/routines/routine-repository';
import { RestTimerService } from '../data/session-live/rest-timer.service';
import type { LocalSession, LocalSet } from '../data/sessions/session';
import { type LastPerformance, SessionRepository } from '../data/sessions/session-repository';
import { type LiveRecords, detectLiveRecords } from '../domain/progress/records';
import type { LoadSuggestion } from '../domain/progress/suggest-load';
import {
  type PriorSet,
  type SessionSummary,
  prefillFor,
  sessionSummary,
} from '../domain/session/session-plan';
import { isWorkingSet } from '../domain/session/session-model';
import { coalesced, quiet } from './coalesce';
import { ExerciseHistory } from './exercise-history';
import { type LiveFocus, type LivePlan, buildLivePlan, extraKey, itemKey } from './live-plan';
import { type SessionRecord, type SessionSet, recordsBySet, sessionRecords } from './records-view';
import { type SetFields, toRepositoryDraft } from './set-draft';
import { SwapStore } from './swap-store';
import { liveRoutineName, setIssueText } from './today-text';

/** Duração com que a série de um exercício de tempo começa, sem histórico (a pessoa ajusta de 5 em 5 s). */
const DEFAULT_DURATION_S = 30;

/** Quanto tempo um recado da tela fica visível. */
const NOTICE_MS = 4000;

/** Um segundo toque em "Concluir série" antes disto é tido como acidente (valor nosso: nenhuma série leva menos). */
export const DOUBLE_TAP_MS = 600;

/** O que se sabe do exercício em foco antes de a série ser concluída: a última vez e a sugestão do dia. */
export interface FocusInfo {
  readonly exerciseId: string;
  readonly last: LastPerformance | null;
  readonly suggestion: LoadSuggestion;
}

/** O resultado de "Concluir série" para a tela: o foco só volta ao botão quando é `saved`. */
export type CompleteOutcome = 'saved' | 'ignored' | 'invalid' | 'failed';

/** Recado curto da tela (lido em voz alta pelo leitor de tela); `n` faz o mesmo texto ser lido de novo. */
export interface Notice {
  readonly text: string;
  readonly tone: 'info' | 'warn';
  readonly n: number;
}

/** Por que uma troca de exercício foi recusada. */
export type SwapOutcome = 'swapped' | 'restored' | 'in-routine' | 'not-allowed';

export interface RecordLine {
  readonly exerciseName: string;
  readonly kind: SessionRecord['kind'];
  readonly previousKg: number;
  readonly valueKg: number;
  readonly reps: number;
}

/** O resumo ao terminar: tudo o que a tela mostra, lido do banco local. */
export interface SummaryData {
  readonly session: LocalSession;
  /** Nome da rotina; `null` no treino livre. */
  readonly routineName: string | null;
  readonly summary: SessionSummary;
  readonly records: readonly RecordLine[];
  readonly sets: readonly LocalSet[];
  readonly exercises: ReadonlyMap<string, LocalExercise>;
}

function toProgress(set: LocalSet): SessionSet {
  return {
    id: set.id,
    exerciseId: set.exerciseId,
    sessionId: set.sessionId,
    setType: set.setType,
    weightKg: set.weightKg,
    reps: set.reps,
    completedAt: set.completedAt,
    position: set.position,
  };
}

/**
 * O treino ao vivo: lê do banco local o treino aberto, as séries, o plano e o exercício em foco, e faz as escritas
 * (concluir, editar, apagar, pular, trocar, encerrar). **Nada do estado vive só na tela**: recarregar a página relê tudo
 * dos repositórios (e, para as trocas de exercício, do `SwapStore`).
 *
 * "Concluir série" grava antes de qualquer outra coisa; só depois olha o recorde e inicia o descanso, com os números da
 * série que acabou de ser feita (não os da próxima).
 */
@Injectable()
export class LiveStore {
  private readonly sessions = inject(SessionRepository);
  private readonly routines = inject(RoutineRepository);
  private readonly catalog = inject(CatalogRepository);
  private readonly progress = inject(ProgressRepository);
  private readonly history = inject(ExerciseHistory);
  private readonly swapStore = inject(SwapStore);
  private readonly timer = inject(RestTimerService);
  private readonly sync = inject(TrainingSync);
  private readonly runtime = inject(QUEUE_RUNTIME);

  readonly ready = signal(false);
  readonly session = signal<LocalSession | undefined>(undefined);
  readonly routine = signal<LocalRoutine | undefined>(undefined);
  readonly sets = signal<readonly LocalSet[]>([]);
  readonly exercises = signal<ReadonlyMap<string, LocalExercise>>(new Map());
  private readonly skipped = signal<readonly string[]>([]);
  private readonly swaps = signal<ReadonlyMap<string, string>>(new Map());
  private readonly chosen = signal<string | null>(null);
  readonly info = signal<FocusInfo | null>(null);
  /** Que série bateu recorde (a estrela da lista), recalculado a cada leitura. */
  readonly recordFlags = signal<ReadonlyMap<string, LiveRecords>>(new Map());
  /** O recorde que a última série concluída acabou de bater; some quando a pessoa o dispensa ou conclui outra. */
  readonly banner = signal<LiveRecords | null>(null);
  readonly notice = signal<Notice | null>(null);
  readonly busy = signal(false);
  /** O campo que a última tentativa de concluir a série recusou (ganha a borda de erro no cartão). */
  readonly issue = signal<'weight' | 'reps' | 'duration' | null>(null);
  /** Quanto durava o descanso que a última série iniciou (a "meta"); desconhecido depois de recarregar a página. */
  readonly restGoalS = signal<number | null>(null);

  readonly plan = computed<LivePlan>(() =>
    buildLivePlan({
      items: this.routine()?.items ?? [],
      sets: this.sets(),
      skipped: this.skipped(),
      swaps: this.swaps(),
      chosen: this.chosen(),
    }),
  );
  readonly focus = computed(() => this.plan().focus);
  /**
   * O nome compacto do treino ("Treino A - peito tríceps"). Vazio até o treino abrir: a rotina e a sessão chegam juntas,
   * então a tela não mostra "Treino livre" por um instante antes de o plano carregar.
   */
  readonly workoutName = computed(() => {
    if (this.session() === undefined) return '';
    const routine = this.routine();
    return routine === undefined
      ? $localize`:@@training.live.free:Treino livre`
      : liveRoutineName(routine.name);
  });
  readonly focusExercise = computed(() => {
    const focus = this.focus();
    return focus === null ? undefined : this.exercises().get(focus.exerciseId);
  });
  /** As séries de trabalho do exercício em foco, neste treino, na ordem em que foram feitas. */
  readonly focusSets = computed(() => {
    const id = this.focus()?.exerciseId;
    return id === undefined ? [] : this.sets().filter((set) => set.exerciseId === id);
  });
  /** Quantas séries de trabalho já estão gravadas no treino (aquecimento não conta). */
  readonly workingSets = computed(
    () => this.sets().filter((set) => isWorkingSet(set.setType)).length,
  );

  /**
   * O que o cartão da série começa preenchido: a mesma série da última vez e, a partir da segunda série do exercício no
   * treino, a série anterior (quem mudou a carga na primeira não quer voltar para a de antes). A `key` muda quando o
   * cartão precisa recomeçar: outro exercício, outra série, ou uma série acabou de ser gravada.
   */
  readonly defaults = computed<{
    readonly key: string;
    readonly fill: string;
    readonly fields: SetFields;
  } | null>(() => {
    const focus = this.focus();
    const exercise = this.focusExercise();
    if (focus === null || exercise === undefined) return null;
    const info = this.info();
    const infoReady = info?.exerciseId === focus.exerciseId;

    const mine = this.focusSets().filter((set) => isWorkingSet(set.setType));
    const own = mine.length > 0 ? mine[mine.length - 1] : null;
    let source: PriorSet | null = null;
    if (own !== null) source = own;
    else if (infoReady && info.last !== null) source = prefillFor(info.last.sets, focus.setNumber);

    return {
      key: `${focus.exerciseId}#${focus.setNumber}#${this.sets().length}`,
      // O que veio do histórico: muda quando ele chega (o cartão intocado se preenche) sem recomeçar um cartão em uso.
      fill: infoReady ? (info.last?.sessionId ?? 'none') : 'wait',
      fields: {
        weightKg: source?.weightKg ?? null,
        reps: source?.reps ?? (exercise.recordType === 'time' ? null : focus.repMin),
        durationS:
          source?.durationS ?? (exercise.recordType === 'time' ? DEFAULT_DURATION_S : null),
        rpe: null,
        warmup: false,
        note: '',
      },
    };
  });

  /** O que se sabe do exercício em foco já foi lido (antes disso o cartão ainda não tem a última vez). */
  readonly infoReady = computed(() => {
    const focus = this.focus();
    return focus === null || this.info()?.exerciseId === focus.exerciseId;
  });

  /** Exercícios acrescentados hoje que ainda não têm série: só existem aqui até a primeira ser gravada. */
  private readonly extras = new Map<string, LocalExercise>();
  private openId: string | undefined;
  private infoTicket = 0;
  private bannerTicket = 0;
  private pendingBanner: Promise<void> = Promise.resolve();
  private lastTapAt = Number.NEGATIVE_INFINITY;
  private noticeCount = 0;

  constructor() {
    effect(() => {
      this.sessions.revision();
      untracked(() => void this.load());
    });
    // O histórico que chega do servidor depois de o treino abrir (primeira passada, ou outro aparelho) entra na hora.
    effect(() => {
      this.sync.lastPullAt();
      untracked(() => {
        this.history.clear();
        void this.load();
      });
    });
    effect(() => {
      const focus = this.focus();
      const pulled = this.sync.lastPullAt() ?? 0;
      const key =
        focus === null ? '' : `${focus.exerciseId}|${focus.repMin}|${focus.repMax}|${pulled}`;
      untracked(() => void this.loadInfo(key === '' ? null : focus));
    });
  }

  /**
   * Relê o treino aberto e tudo o que a tela mostra dele. Pedidos que chegam no meio de uma leitura viram uma passada
   * extra, e quem pediu só recebe a resposta depois dela: nunca se vê o estado de antes da própria escrita.
   */
  readonly load = coalesced(
    quiet(
      () => this.read(),
      () => this.ready.set(true),
    ),
  );

  private async read(): Promise<void> {
    const session = await this.sessions.activeSession();
    if (session?.id !== this.openId) {
      // Outro treino (ou nenhum): nada do anterior vale.
      this.openId = session?.id;
      this.chosen.set(null);
      this.banner.set(null);
      this.extras.clear();
    }
    if (session === undefined) {
      this.session.set(undefined);
      this.routine.set(undefined);
      this.sets.set([]);
      this.recordFlags.set(new Map());
      this.ready.set(true);
      return;
    }

    const [routine, sets, skipped] = await Promise.all([
      session.routineId === null ? undefined : this.routines.get(session.routineId),
      this.sessions.setsOfSession(session.id),
      this.sessions.skippedExercises(),
    ]);
    const swaps = this.swapStore.read(session.id);

    const ids = new Set<string>([
      ...(routine?.items.map((item) => item.exerciseId) ?? []),
      ...swaps.values(),
      ...sets.map((set) => set.exerciseId),
      ...this.extras.keys(),
    ]);
    const exercises = new Map([...this.extras, ...(await this.exercisesById(ids))]);

    this.session.set(session);
    this.routine.set(routine);
    this.sets.set(sets);
    this.skipped.set(skipped);
    this.swaps.set(swaps);
    this.exercises.set(exercises);
    this.ready.set(true);
    // As estrelas de recorde dependem do histórico inteiro (mais lento): chegam depois, sem segurar a tela.
    void this.loadFlags();
  }

  /** Recalcula que séries bateram recorde (uma leitura por vez). */
  private readonly loadFlags = coalesced(quiet(() => this.readFlags()));

  private async readFlags(): Promise<void> {
    const session = this.session();
    const sets = this.sets();
    const ids = [...new Set(sets.map((set) => set.exerciseId))];
    if (session === undefined || ids.length === 0) {
      this.recordFlags.set(new Map());
      return;
    }
    const past = await this.history.before(ids, session.id);
    this.recordFlags.set(recordsBySet(past, sets.map(toProgress)));
  }

  /**
   * A série em foco, ao ser gravada, fecha o exercício? Só a última série da meta fecha; numa supersérie o exercício só
   * fecha quando a rodada do par inteiro fecha (os outros do grupo já cumpriram a meta, ou foram pulados).
   */
  closesExercise(focus: LiveFocus | null = this.focus()): boolean {
    if (focus === null || focus.itemId === null || focus.targetSets === null || focus.extra) {
      return false;
    }
    if (focus.setNumber < focus.targetSets) return false;
    if (focus.supersetGroup === null) return true;
    const entries = this.plan().entries;
    return (this.routine()?.items ?? [])
      .filter((item) => item.supersetGroup === focus.supersetGroup && item.id !== focus.itemId)
      .every((item) => {
        const entry = entries.find((candidate) => candidate.itemId === item.id);
        return entry === undefined || entry.skipped || entry.doneSets >= item.targetSets;
      });
  }

  /** Conclui a série: grava no aparelho, olha o recorde e só então inicia o descanso. */
  async completeSet(fields: SetFields): Promise<CompleteOutcome> {
    const focus = this.focus();
    const exercise = this.focusExercise();
    const session = this.session();
    if (focus === null || exercise === undefined || session === undefined) return 'failed';

    const closes = this.closesExercise(focus);
    const now = this.runtime.now();
    if (this.busy() || now - this.lastTapAt < DOUBLE_TAP_MS) {
      this.say(
        $localize`:@@training.live.double-tap:Toque repetido ignorado: a série já foi concluída.`,
        'warn',
      );
      return 'ignored';
    }
    this.lastTapAt = now;
    this.busy.set(true);
    // As séries que este exercício já tinha neste treino (para o recorde), antes de a nova entrar.
    const earlier = this.sets()
      .filter((set) => set.exerciseId === exercise.id)
      .map(toProgress);
    try {
      const result = await this.sessions.addSet(toRepositoryDraft(exercise, fields));
      if (result.status === 'invalid') {
        const first = result.issues[0];
        this.issue.set(
          first?.path === 'weightKg'
            ? 'weight'
            : first?.path === 'reps'
              ? 'reps'
              : first?.path === 'durationS'
                ? 'duration'
                : null,
        );
        this.say(setIssueText(first?.code ?? 'set-type-invalid'), 'warn');
        return 'invalid';
      }
      if (result.status !== 'saved') {
        this.say(this.failureText(result.status), 'warn');
        return 'failed';
      }

      this.issue.set(null);

      // O descanso é o da série que acabou de ser feita; no meio de uma supersérie não há descanso, e a última série do
      // exercício também não tem: a pessoa vai até o próximo aparelho, e um descanso guardado abriria o próximo já correndo.
      if (closes) {
        await this.timer.skip();
      } else if (focus.rest) {
        this.restGoalS.set(focus.restSeconds);
        await this.timer.start(focus.restSeconds);
      }

      await this.load();
      this.afterSet();
      this.say($localize`:@@training.live.saved:Série gravada no aparelho.`, 'info');
      // O botão volta a funcionar já; o aviso de recorde (precisa do histórico inteiro) chega logo depois.
      this.busy.set(false);
      this.pendingBanner = this.updateBanner(
        exercise.id,
        session.id,
        earlier,
        toProgress(result.set),
      );
      return 'saved';
    } finally {
      this.busy.set(false);
    }
  }

  /** Espera o que ficou para depois de concluir a série (o aviso de recorde). Serve aos testes. */
  settled(): Promise<void> {
    return this.pendingBanner;
  }

  /** Recorde: a série nova contra tudo o que veio antes dela (histórico e séries anteriores deste treino). */
  private async updateBanner(
    exerciseId: string,
    sessionId: string,
    earlier: readonly SessionSet[],
    set: SessionSet,
  ): Promise<void> {
    const ticket = ++this.bannerTicket;
    try {
      const past = (await this.history.before([exerciseId], sessionId)).get(exerciseId) ?? [];
      if (ticket !== this.bannerTicket) return;
      const found = detectLiveRecords([...past, ...earlier], set);
      this.banner.set(found.maxWeight !== null || found.oneRepMax !== null ? found : null);
    } catch {
      // Sem o histórico não há como comparar: o aviso de recorde simplesmente não aparece.
    }
  }

  /** Muda uma série já gravada (também a de um treino encerrado). Devolve o texto do erro, ou `null` se salvou. */
  async editSet(set: LocalSet, fields: SetFields): Promise<string | null> {
    const exercise =
      this.exercises().get(set.exerciseId) ?? (await this.catalog.get(set.exerciseId));
    const recordType = exercise?.recordType ?? 'weight_reps';
    const result = await this.sessions.editSet(set.id, {
      setType: fields.warmup ? 'warmup' : set.setType === 'warmup' ? 'work' : set.setType,
      weightKg: recordType === 'weight_reps' ? fields.weightKg : null,
      reps: recordType === 'time' ? null : fields.reps,
      durationS: recordType === 'time' ? fields.durationS : null,
      rpe: fields.rpe,
      note: fields.note,
    });
    if (result.status === 'saved') return null;
    if (result.status === 'invalid')
      return setIssueText(result.issues[0]?.code ?? 'set-type-invalid');
    return this.failureText(result.status);
  }

  /** Apaga uma série (lápide). Devolve se apagou. */
  async deleteSet(id: string): Promise<boolean> {
    const result = await this.sessions.deleteSet(id);
    return result.status === 'saved';
  }

  /** Tira o exercício do plano de hoje (as séries que ele já teve ficam). */
  async skipCurrent(): Promise<void> {
    const focus = this.focus();
    if (focus === null || focus.itemId === null) return;
    await this.sessions.setSkipped(focus.planExerciseId, true);
    if (this.chosen() === focus.key) this.chosen.set(null);
    await this.load();
  }

  /** Escolhe uma linha do plano como foco; uma linha pulada volta ao plano. */
  async choose(key: string | null): Promise<void> {
    if (key === null) {
      this.chosen.set(null);
      return;
    }
    const entry = this.plan().entries.find((candidate) => candidate.key === key);
    if (entry?.skipped) {
      await this.sessions.setSkipped(entry.planExerciseId, false);
      await this.load();
    }
    this.chosen.set(key);
  }

  /** Escolhe um exercício para fazer agora, dentro ou fora da rotina (treino livre, ou "adicionar exercício"). */
  async addExercise(exercise: LocalExercise): Promise<void> {
    this.remember(exercise);
    const inItem = this.plan().entries.find(
      (entry) => entry.exerciseId === exercise.id && entry.itemId !== null,
    );
    await this.choose(inItem ? inItem.key : extraKey(exercise.id));
  }

  /**
   * Faz outro exercício no lugar do atual, só neste treino. A rotina não muda: as séries guardam o exercício de fato
   * feito. Trocar de volta pelo exercício original desfaz a troca; um exercício que já está na rotina não serve (as
   * séries dele seriam contadas duas vezes).
   */
  async swapCurrent(exercise: LocalExercise): Promise<SwapOutcome> {
    const focus = this.focus();
    const session = this.session();
    if (focus === null || focus.itemId === null || session === undefined) return 'not-allowed';

    const swaps = new Map(this.swaps());
    if (exercise.id === focus.planExerciseId) {
      swaps.delete(focus.itemId);
      this.persistSwaps(session.id, swaps);
      await this.load();
      this.chosen.set(itemKey(focus.itemId));
      return 'restored';
    }

    const items = this.routine()?.items ?? [];
    // Já está na rotina (como previsto ou como troca de outro item): as séries dele seriam contadas duas vezes.
    const taken = items.some(
      (item) =>
        item.id !== focus.itemId &&
        (item.exerciseId === exercise.id || swaps.get(item.id) === exercise.id),
    );
    if (taken || exercise.id === focus.exerciseId) return 'in-routine';

    this.remember(exercise);
    swaps.set(focus.itemId, exercise.id);
    this.persistSwaps(session.id, swaps);
    await this.load();
    this.chosen.set(itemKey(focus.itemId));
    return 'swapped';
  }

  /** Encerra o treino. Devolve o id para abrir o resumo, ou `null` se não deu. */
  async finish(): Promise<string | null> {
    const session = this.session();
    if (session === undefined) return null;
    const result = await this.sessions.finish();
    if (result.status !== 'saved') {
      this.say(this.failureText(result.status), 'warn');
      return null;
    }
    await this.timer.skip();
    this.swapStore.clear();
    return session.id;
  }

  /** Cancela o treino: some por lápide (as séries também), sem perder o que a fila ainda tem de outros treinos. */
  async discard(): Promise<boolean> {
    const result = await this.sessions.discard();
    if (result.status !== 'saved') return false;
    await this.timer.skip();
    this.swapStore.clear();
    return true;
  }

  /** Lê o resumo de um treino encerrado: números, recordes (com o valor de antes) e séries. */
  async loadSummary(sessionId: string): Promise<SummaryData | null> {
    const session = await this.sessions.get(sessionId);
    if (session === undefined || session.finishedAt === null) return null;
    const [sets, routine] = await Promise.all([
      this.sessions.setsOfSession(sessionId),
      session.routineId === null ? undefined : this.routines.get(session.routineId),
    ]);
    const ids = new Set(sets.map((set) => set.exerciseId));
    const [exercises, past] = await Promise.all([
      this.exercisesById(ids),
      this.history.before([...ids], sessionId),
    ]);

    const records: RecordLine[] = sessionRecords(past, sets.map(toProgress)).map((record) => ({
      exerciseName: exercises.get(record.exerciseId)?.name ?? '',
      kind: record.kind,
      previousKg: record.previousKg,
      valueKg: record.valueKg,
      reps: record.reps,
    }));
    return {
      session,
      routineName: routine?.name ?? null,
      summary: sessionSummary(sets, exercises, session),
      records,
      sets,
      exercises,
    };
  }

  /** Dispensa o aviso de recorde. */
  dismissBanner(): void {
    this.banner.set(null);
  }

  /** Fala um recado (a região "polite" da tela o lê). */
  say(text: string, tone: Notice['tone']): void {
    const n = ++this.noticeCount;
    this.notice.set({ text, tone, n });
    // O recado some sozinho (um mais novo não é apagado pelo temporizador do anterior).
    this.runtime.setTimeout(() => {
      if (this.noticeCount === n) this.notice.set(null);
    }, NOTICE_MS);
  }

  private afterSet(): void {
    // Uma linha escolhida segue em foco até as séries dela acabarem; depois a tela volta ao plano.
    const chosen = this.chosen();
    if (chosen === null) return;
    const entry = this.plan().entries.find((candidate) => candidate.key === chosen);
    // Na supersérie o foco segue o par (a outra metade da rodada), então a escolha só vale para a primeira série.
    const inSuperset = (this.focus()?.supersetGroup ?? null) !== null;
    if (
      inSuperset ||
      (entry?.itemId != null && entry.targetSets !== null && entry.doneSets >= entry.targetSets)
    ) {
      this.chosen.set(null);
    }
  }

  private failureText(status: string): string {
    switch (status) {
      case 'storage-full':
        return $localize`:@@training.live.storage-full:O aparelho está sem espaço: a alteração não foi gravada.`;
      case 'no-active-session':
        return $localize`:@@training.live.no-session:Este treino já foi encerrado.`;
      case 'exercise-not-found':
        return $localize`:@@training.live.exercise-missing:Este exercício não está mais no catálogo do aparelho.`;
      default:
        return $localize`:@@training.live.write-failed:Não foi possível gravar. Tente de novo.`;
    }
  }

  private persistSwaps(sessionId: string, swaps: ReadonlyMap<string, string>): void {
    if (swaps.size === 0) this.swapStore.clear();
    else this.swapStore.write(sessionId, swaps);
  }

  private remember(exercise: LocalExercise): void {
    this.extras.set(exercise.id, exercise);
    this.exercises.update((current) => new Map(current).set(exercise.id, exercise));
  }

  private async exercisesById(ids: ReadonlySet<string>): Promise<Map<string, LocalExercise>> {
    const found = new Map<string, LocalExercise>();
    for (const id of ids) {
      const exercise = await this.catalog.get(id);
      if (exercise !== undefined) found.set(id, exercise);
    }
    return found;
  }

  private async loadInfo(
    focus: { readonly exerciseId: string; readonly repMin: number; readonly repMax: number } | null,
  ): Promise<void> {
    const ticket = ++this.infoTicket;
    if (focus === null) {
      this.info.set(null);
      return;
    }
    try {
      const [last, suggestion] = await Promise.all([
        this.sessions.lastPerformance(focus.exerciseId),
        this.progress.lastLoadSuggestion({
          exerciseId: focus.exerciseId,
          repMin: focus.repMin,
          repMax: focus.repMax,
        }),
      ]);
      if (ticket === this.infoTicket)
        this.info.set({ exerciseId: focus.exerciseId, last, suggestion });
    } catch {
      // Sem banco local não há "última vez" nem sugestão; a série continua podendo ser feita à mão.
      if (ticket === this.infoTicket) this.info.set(null);
    }
  }
}
