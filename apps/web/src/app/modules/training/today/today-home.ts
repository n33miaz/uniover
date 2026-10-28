import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { CatalogRepository } from '../data/catalog/catalog-repository';
import { RoutineRepository } from '../data/routines/routine-repository';
import { SessionRepository } from '../data/sessions/session-repository';
import { TrainingSync } from '../data/sync/training-sync';
import { IllustrationPrefetcher } from '../illustrations/illustration-prefetcher';
import type { RoutineEntry } from '../routines/routine-stats';
import { formatKg } from '../shell/format';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';
import { ProgramSuggestion } from './program-suggestion';
import { RoutinePickerSheet } from './routine-picker-sheet';
import { TodayGlyph } from './today-glyph';
import { type RoutineLine, TodayStore } from './today-store';
import { ageLabel, dayLabel, repsRangeText, routineSummary } from './today-text';
import { WeekCalendar } from './week-calendar';

/**
 * A aba Hoje antes (e fora) do treino ao vivo: a rotina do dia em cima, com a ação principal ("Iniciar Treino") e o
 * ícone de configuração no canto, e a semana com meta embaixo, só para confirmar o contexto. Também é onde se continua um
 * treino aberto, se configura a rotina (trocar de ficha, meta, ausência e nota), se começa um treino livre e onde
 * aparecem os avisos que importam (treino aberto em outro aparelho, treino recusado pelo servidor).
 * Lê tudo do banco local: sem rede não há erro, só o que está guardado no aparelho.
 */
@Component({
  selector: 'app-today-home',
  imports: [
    RouterLink,
    TrainingGlyph,
    TodayGlyph,
    RoutinePickerSheet,
    ProgramSuggestion,
    TrainingSheet,
    WeekCalendar,
  ],
  templateUrl: './today-home.html',
  styleUrl: './today-home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // O app instalado volta do segundo plano sem recarregar: ao voltar, a ficha do dia é calculada de novo.
  host: {
    '(document:visibilitychange)': 'refreshDay()',
    '(window:focus)': 'refreshDay()',
  },
})
export class TodayHome {
  protected readonly store = inject(TodayStore);
  private readonly sessions = inject(SessionRepository);
  private readonly routines = inject(RoutineRepository);
  private readonly catalog = inject(CatalogRepository);
  private readonly sync = inject(TrainingSync);
  private readonly prefetcher = inject(IllustrationPrefetcher);
  private readonly runtime = inject(QUEUE_RUNTIME);
  protected readonly online = inject(ConnectivityService).online;

  /** O treino abriu (ou já estava aberto): a página mostra o treino ao vivo. */
  readonly started = output<void>();

  private warmedKey = '';

  protected readonly pickerOpen = signal(false);
  protected readonly programChoiceOpen = signal(false);
  private readonly pendingRoutineId = signal<string | null>(null);
  protected readonly starting = signal(false);
  protected readonly confirmingClose = signal(false);
  protected readonly message = signal<{
    readonly text: string;
    readonly tone: 'ok' | 'warn';
  } | null>(null);

  protected readonly freeName = $localize`:@@training.today.free-name:Treino livre`;
  protected readonly programHeading = $localize`:@@training.today.program-heading:Programa da semana`;
  protected readonly programSkipLabel = $localize`:@@training.today.program-skip:Seguir sem programa`;
  protected readonly confirmLabel = $localize`:@@training.today.forgotten-label:Confirmar o encerramento do treino do outro aparelho`;
  protected readonly linesLabel = $localize`:@@training.today.lines-label:Exercícios da rotina`;
  protected readonly missingName = $localize`:@@training.today.missing-name:Exercício removido`;

  protected readonly entry = this.store.selected;
  protected readonly today = computed(() => {
    this.store.plan();
    return dayLabel(this.runtime.now());
  });
  protected readonly summary = computed(() => {
    const entry = this.entry();
    return entry === undefined ? '' : routineSummary(entry);
  });
  protected readonly catalogMissing = computed(() => this.store.catalogCount() === 0);
  protected readonly progressText = computed(() => {
    const progress = this.store.activeProgress();
    if (progress === null) return '';
    const done = progress.done;
    const planned = progress.planned;
    return planned > 0
      ? $localize`:@@training.today.running-progress:${done}:done: de ${planned}:planned: séries`
      : done === 1
        ? $localize`:@@training.today.running-one:1 série feita`
        : $localize`:@@training.today.running-many:${done}:done: séries feitas`;
  });
  protected readonly awaitingText = computed(() => {
    const count = this.store.awaitingSets();
    if (count === 0) return '';
    return count === 1
      ? $localize`:@@training.today.awaiting-one:1 série aguardando envio`
      : $localize`:@@training.today.awaiting-many:${count}:count: séries aguardando envio`;
  });
  protected readonly otherAge = computed(() => {
    const other = this.store.otherDevice();
    return other === undefined ? '' : ageLabel(other.ageMs);
  });

  constructor() {
    // Relê ao abrir e a cada gravação (o fim de um treino muda a rotina do dia e o resumo da semana).
    effect(() => {
      this.sessions.revision();
      this.routines.revision();
      untracked(() => void this.store.loadHome());
    });
    // Com rede, as ilustrações das rotinas ativas vão para o cache: na academia, sem sinal, elas aparecem do mesmo jeito.
    effect(() => {
      const entries = this.store.entries();
      untracked(() => void this.warmIllustrations(entries));
    });
  }

  /** Relê as rotinas e a ficha do dia; barato, e só age quando a tela está visível. */
  protected refreshDay(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void this.store.loadHome();
  }

  protected lineSub(line: RoutineLine): string {
    const sets = line.sets;
    const range = repsRangeText(line.repMin, line.repMax);
    const plan = $localize`:@@training.today.line-plan:${sets}:sets: × ${range}:range:`;
    const parts = [plan];
    if (line.last !== null) {
      const last = line.last;
      parts.push($localize`:@@training.today.line-last:última vez ${last}:last:`);
    }
    if (line.superset) parts.push($localize`:@@training.today.line-superset:supersérie`);
    return parts.join(' · ');
  }

  protected tryText(line: RoutineLine): string {
    const kg = formatKg(line.tryKg ?? 0);
    return $localize`:@@training.today.line-try:tente ${kg}:kg:`;
  }

  protected async start(routineId: string | null): Promise<void> {
    if (this.starting()) return;
    this.starting.set(true);
    this.message.set(null);
    try {
      const outcome = await this.store.start(routineId);
      if (outcome === 'started' || outcome === 'resumed') {
        // A página só abre o treino ao vivo com o treino já lido: sem isto ela voltaria a Hoje por um instante.
        await this.store.loadCore();
        this.started.emit();
      } else if (outcome === 'blocked') {
        await this.store.loadCore();
      } else if (outcome === 'program-choice') {
        this.pendingRoutineId.set(routineId);
        this.programChoiceOpen.set(true);
      } else {
        this.message.set({
          tone: 'warn',
          text: $localize`:@@training.today.storage-full:O aparelho está sem espaço: o treino não foi aberto.`,
        });
      }
    } finally {
      this.starting.set(false);
    }
  }

  protected async chooseProgram(): Promise<void> {
    this.programChoiceOpen.set(false);
    await this.store.loadHome();
    await this.start(this.entry()?.routine.id ?? null);
  }

  protected async continueWithoutProgram(): Promise<void> {
    const routineId = this.pendingRoutineId();
    this.store.dismissProgramBeforeStart();
    this.programChoiceOpen.set(false);
    await this.start(routineId);
  }

  protected async closeForgotten(): Promise<void> {
    const other = this.store.otherDevice();
    if (other === undefined) return;
    this.confirmingClose.set(false);
    const closed = await this.store.closeForgotten(other.session.id);
    this.message.set(
      closed
        ? {
            tone: 'ok',
            text: $localize`:@@training.today.closed-forgotten:Treino esquecido encerrado. Agora você pode começar o de hoje.`,
          }
        : {
            tone: 'warn',
            text: $localize`:@@training.today.close-failed:Não foi possível encerrar o treino do outro aparelho.`,
          },
    );
  }

  protected async resend(): Promise<void> {
    const sent = await this.store.resendFailed();
    this.message.set(
      sent
        ? {
            tone: 'ok',
            text: $localize`:@@training.today.resent:Reenviamos o treino. Se o servidor recusar de novo, o aviso volta.`,
          }
        : {
            tone: 'warn',
            text: $localize`:@@training.today.resend-failed:Não foi possível reenviar agora. O treino continua guardado no aparelho.`,
          },
    );
  }

  protected retryDownload(): void {
    void this.sync.pullNow();
  }

  private async warmIllustrations(entries: readonly RoutineEntry[]): Promise<void> {
    try {
      await this.warm(entries);
    } catch {
      // Aquecer o cache é só uma gentileza: sem banco local ou sem rede, nada a fazer.
    }
  }

  private async warm(entries: readonly RoutineEntry[]): Promise<void> {
    if (!this.online() || entries.length === 0) return;
    const slugs: string[] = [];
    for (const entry of entries) {
      for (const item of entry.routine.items) {
        const exercise = await this.catalog.get(item.exerciseId);
        if (exercise) slugs.push(exercise.slug);
      }
    }
    // A mesma lista não é buscada de novo a cada gravação: o aquecimento é uma vez por conjunto de exercícios.
    const key = [...new Set(slugs)].sort().join('|');
    if (key === this.warmedKey) return;
    this.warmedKey = key;
    await this.prefetcher.warm(slugs);
  }
}
