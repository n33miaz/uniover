import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewEncapsulation,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { QuickTour } from '../../../shared/ui/quick-tour';
import type { LocalExercise } from '../data/catalog/exercise';
import { WakeLockService } from '../data/session-live/wake-lock.service';
import { illustrationFor, illustrationUrl } from '../illustrations/illustration-map';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingHeaderActions } from '../shell/training-header-actions';
import { ExerciseHistory } from './exercise-history';
import { ExerciseChooserSheet } from './exercise-chooser-sheet';
import { LiveStore } from './live-store';
import { PlanSheet } from './plan-sheet';
import { recommendExercise } from './recommend-exercise';
import { registerOpenSessionWork } from './open-session-work';
import { type MenuAction, SessionMenuSheet } from './session-menu-sheet';
import { TodayStore } from './today-store';
import { awaitingSetsText } from './today-text';
import { WorkoutDaySkeleton } from './workout-skeletons';

/**
 * A escolha do exercício durante um treino aberto. Ela deixa a pessoa trocar de máquina sem reordenar a rotina nem
 * esconder o que já foi concluído; a próxima sugestão continua sendo apenas um atalho, nunca uma obrigação. As opções
 * do treino (tela acesa, adicionar, terminar, cancelar) ficam no menu do topo, como na tela de registro.
 */
@Component({
  selector: 'app-workout-day',
  imports: [
    RouterLink,
    TrainingGlyph,
    ExerciseChooserSheet,
    SessionMenuSheet,
    WorkoutDaySkeleton,
    PlanSheet,
    QuickTour,
  ],
  providers: [TodayStore, LiveStore, ExerciseHistory],
  template: `
    <section class="day" aria-labelledby="workout-title">
      <h2 id="workout-title" class="ui-visually-hidden" i18n="@@training.day.title">Treino</h2>

      @if (awaitingText(); as waiting) {
        <p class="sending">
          <app-training-glyph name="hourglass" />
          <span>{{ waiting }}</span>
        </p>
      }

      @if (!live.ready()) {
        <app-workout-day-skeleton />
      } @else if (live.session() === undefined) {
        <section class="empty ui-card" aria-labelledby="empty-title">
          <span class="ui-tile lg"><app-training-glyph name="info" /></span>
          <h2 id="empty-title" i18n="@@training.day.empty-title">Treino Não Encontrado</h2>
          <a routerLink="/treino" class="primary ui-btn" i18n="@@training.day.empty-back"
            >Escolher Treino</a
          >
        </section>
      } @else {
        <p class="routine-name">{{ live.workoutName() }}</p>

        <details class="session-limit">
          <summary>
            <span i18n="@@training.day.limit">Tempo máximo</span>
            @if (timeLeftText(); as remaining) {
              <span class="meta">{{ remaining }}</span>
            }
          </summary>
          <form (submit)="saveLimit($event, limit.value)">
            <label for="workout-limit" i18n="@@training.day.limit-minutes">Minutos</label>
            <input
              #limit
              id="workout-limit"
              class="ui-input"
              type="number"
              min="1"
              max="1440"
              step="1"
              [attr.inputmode]="'numeric'"
              [value]="live.limitMinutes() ?? ''"
            />
            <button type="submit" class="secondary ui-btn" [disabled]="savingLimit()">
              <span i18n="@@training.day.save-limit">Salvar</span>
            </button>
            @if (live.limitMinutes() !== null) {
              <button
                type="button"
                class="secondary ui-btn"
                [disabled]="savingLimit()"
                (click)="saveLimit($event, '')"
              >
                <span i18n="@@training.day.clear-limit">Remover</span>
              </button>
            }
            @if (limitError()) {
              <p role="status" i18n="@@training.day.limit-failed">O limite não foi salvo.</p>
            }
          </form>
        </details>
        <app-quick-tour [tourId]="'training-session'" [heading]="tourHeading" [steps]="tourSteps" />

        @if (live.plan().entries.length > 0) {
          <div class="cards">
            @for (entry of live.plan().entries; track entry.key) {
              <button
                type="button"
                class="exercise ui-card"
                [class.suggested]="entry.key === suggestedKey()"
                [class.done]="complete(entry)"
                [class.skipped]="entry.skipped"
                [attr.aria-current]="entry.key === suggestedKey() ? 'step' : null"
                (click)="open(entry.key)"
              >
                <span class="art">
                  @if (art(entry.exerciseId); as src) {
                    <img [src]="src" alt="" width="120" height="120" [attr.decoding]="'async'" />
                  } @else {
                    <app-training-glyph name="dumbbell" />
                  }
                </span>
                <span class="details">
                  <span
                    class="name"
                    [attr.title]="live.exercises().get(entry.exerciseId)?.name ?? unknownName"
                    >{{ live.exercises().get(entry.exerciseId)?.name ?? unknownName }}</span
                  >
                  <span class="meta">{{
                    entry.finished
                      ? finishedLabel
                      : complete(entry) && !entry.skipped
                        ? extraSeriesLabel
                        : progressText(entry.doneSets, entry.targetSets, entry.skipped)
                  }}</span>
                </span>
                @if (entry.key === suggestedKey()) {
                  <span class="ui-chip accent" i18n="@@training.day.suggested">Próximo</span>
                } @else if (complete(entry)) {
                  <app-training-glyph class="check" name="check" />
                }
              </button>
            }
          </div>
        }

        @if (live.ready() && live.plan().entries.length === 0) {
          <button type="button" class="secondary ui-btn block" (click)="chooserOpen.set(true)">
            <app-training-glyph name="plus" />
            <span i18n="@@training.day.choose">Escolher Exercício</span>
          </button>
        }

        <div class="dock">
          <button
            type="button"
            class="ui-btn block go"
            [class.primary]="allDone()"
            [class.secondary]="!allDone()"
            [disabled]="live.workingSets() === 0"
            (click)="finish()"
          >
            <app-training-glyph name="check" />
            <span i18n="@@training.day.finish">Concluir Treino</span>
          </button>
        </div>
      }
    </section>

    @if (chooserOpen()) {
      <app-exercise-chooser-sheet
        [heading]="chooseHeading"
        (picked)="openExtra($event)"
        (closed)="chooserOpen.set(false)"
      />
    }

    @if (planOpen()) {
      <app-plan-sheet
        [entries]="live.plan().entries"
        [names]="names()"
        [focusKey]="suggestedKey()"
        (chosen)="openFromPlan($event)"
        (add)="planOpen.set(false); chooserOpen.set(true)"
        (closed)="planOpen.set(false)"
      />
    }

    @if (menuOpen()) {
      <app-session-menu-sheet
        [canFinish]="live.workingSets() > 0"
        [screenSupported]="screenSupported()"
        [screenOn]="screenOn()"
        [screenRefused]="screenRefused()"
        (action)="onMenu($event)"
        (screen)="onScreen($event)"
        (closed)="menuOpen.set(false)"
      />
    }
  `,
  styleUrl: './workout-day.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkoutDay {
  protected readonly live = inject(LiveStore);
  private readonly today = inject(TodayStore);
  private readonly router = inject(Router);
  private readonly wake = inject(WakeLockService);
  private readonly headerActions = inject(TrainingHeaderActions);
  private readonly runtime = inject(QUEUE_RUNTIME);

  protected readonly menuLabel = $localize`:@@training.live.menu:Opções do treino`;
  protected readonly unknownName = $localize`:@@training.day.unknown:Exercício removido`;
  protected readonly chooseHeading = $localize`:@@training.day.choose-title:Adicionar Exercício`;
  protected readonly chooserOpen = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly planOpen = signal(false);
  protected readonly finishedLabel = $localize`:@@training.day.finished:Finalizado`;
  protected readonly names = computed(
    () => new Map([...this.live.exercises()].map(([id, exercise]) => [id, exercise.name])),
  );
  protected readonly screenRefused = signal(false);
  protected readonly screenSupported = this.wake.supported;
  protected readonly screenOn = this.wake.active;
  /** "3 séries aguardando envio": sem rede é o estado normal, e a tela do dia também o mostra. */
  protected readonly awaitingText = computed(() => awaitingSetsText(this.today.awaitingSets()));
  protected readonly savingLimit = signal(false);
  protected readonly limitError = signal(false);
  protected readonly tourHeading = $localize`:@@training.day.tour-heading:Novidades no treino`;
  protected readonly tourSteps = [
    $localize`:@@training.day.tour-extra:Toque num exercício concluído para fazer uma série extra.`,
    $localize`:@@training.day.tour-exercises:Em Exercícios do Treino, finalize um item ou escolha um similar.`,
    $localize`:@@training.day.tour-limit:Defina o tempo máximo para destacar um exercício que cabe no tempo restante.`,
  ];
  private readonly now = signal(this.runtime.now());
  private readonly secondsLeft = computed(() => {
    const session = this.live.session();
    const limit = this.live.limitMinutes();
    if (!session || limit === null) return null;
    return Math.max(0, limit * 60 - Math.floor((this.now() - session.startedAt) / 1000));
  });
  protected readonly timeLeftText = computed(() => {
    const seconds = this.secondsLeft();
    if (seconds === null) return '';
    if (seconds === 0) return $localize`:@@training.day.limit-ended:Tempo atingido`;
    const minutes = Math.ceil(seconds / 60);
    return $localize`:@@training.day.limit-left:${minutes}:minutes: min restantes`;
  });
  protected readonly suggestedKey = computed(() => {
    const seconds = this.secondsLeft();
    if (seconds === null) return this.live.focus()?.key ?? null;
    return recommendExercise(
      this.live.plan().entries,
      this.live.routine()?.items ?? [],
      this.live.exercises(),
      this.live.sets(),
      seconds,
    );
  });
  /** Tudo o que o plano pedia foi feito (ou pulado): terminar passa a ser a ação principal da tela. */
  protected readonly allDone = computed(() => {
    const entries = this.live.plan().entries;
    return (
      this.live.workingSets() > 0 &&
      entries.length > 0 &&
      entries.every((entry) => entry.skipped || this.complete(entry))
    );
  });

  constructor() {
    // O treino aberto também segura a recarga automática de atualização aqui, na tela do dia (a do exercício registra o mesmo na
    // dela): voltar de um exercício para esta tela não pode soltar a guarda.
    registerOpenSessionWork(() => this.live.session());
    // A tela acesa vale só enquanto o treino está aberto na tela: sair do treino solta o bloqueio.
    const removeMenu = this.headerActions.register({
      id: 'workout-menu',
      label: this.menuLabel,
      run: () => this.menuOpen.set(true),
    });
    const tick = this.runtime.setInterval(() => {
      if (this.live.limitMinutes() !== null) this.now.set(this.runtime.now());
    }, 1000);
    inject(DestroyRef).onDestroy(() => {
      this.runtime.clearInterval(tick);
      removeMenu();
      void this.wake.release();
    });
  }

  protected async saveLimit(event: Event, value: string): Promise<void> {
    event.preventDefault();
    if (this.savingLimit()) return;
    this.savingLimit.set(true);
    try {
      this.now.set(this.runtime.now());
      this.limitError.set(!(await this.live.setLimitMinutes(value === '' ? null : Number(value))));
    } finally {
      this.savingLimit.set(false);
    }
  }

  protected art(exerciseId: string): string | null {
    const exercise = this.live.exercises().get(exerciseId);
    const art = exercise ? illustrationFor(exercise.slug) : undefined;
    return art ? illustrationUrl(art.frames[0]) : null;
  }

  protected complete(entry: {
    readonly doneSets: number;
    readonly targetSets: number | null;
    readonly finished?: boolean;
  }): boolean {
    return (
      entry.finished === true || (entry.targetSets !== null && entry.doneSets >= entry.targetSets)
    );
  }

  protected readonly extraSeriesLabel = $localize`:@@training.day.more-series:Fazer série extra`;

  protected progressText(done: number, target: number | null, skipped: boolean): string {
    if (skipped) return $localize`:@@training.day.skipped:Pulado`;
    if (target === null) {
      return done === 1
        ? $localize`:@@training.day.extra-one:1 série`
        : $localize`:@@training.day.extra-many:${done}:count: séries`;
    }
    return $localize`:@@training.day.progress:${done}:done: de ${target}:target: séries`;
  }

  protected async open(key: string): Promise<void> {
    await this.router.navigate(['/treino/sessao/exercicio'], { queryParams: { exercicio: key } });
  }

  protected async openFromPlan(key: string): Promise<void> {
    this.planOpen.set(false);
    await this.open(key);
  }

  protected async openExtra(exercise: LocalExercise): Promise<void> {
    this.chooserOpen.set(false);
    await this.router.navigate(['/treino/sessao/exercicio'], {
      queryParams: { exercicio: `extra:${exercise.id}` },
    });
  }

  protected async onMenu(action: MenuAction): Promise<void> {
    switch (action) {
      case 'plan':
        this.menuOpen.set(false);
        this.planOpen.set(true);
        break;
      case 'add':
        this.menuOpen.set(false);
        this.chooserOpen.set(true);
        break;
      case 'finish':
        this.menuOpen.set(false);
        await this.finish();
        break;
      case 'discard':
        if (await this.live.discard()) {
          await this.wake.release();
          this.menuOpen.set(false);
          await this.router.navigateByUrl('/treino');
        }
        break;
      default:
        this.menuOpen.set(false);
    }
  }

  protected async onScreen(on: boolean): Promise<void> {
    this.screenRefused.set(false);
    if (on) {
      const granted = await this.wake.request();
      if (!granted) {
        // Sem suporte ou recusado: o interruptor volta a desligado e a folha diz por quê.
        await this.wake.release();
        this.screenRefused.set(this.wake.supported());
      }
    } else {
      await this.wake.release();
    }
  }

  protected async finish(): Promise<void> {
    const id = await this.live.finish();
    if (id !== null) {
      await this.wake.release();
      await this.router.navigateByUrl(`/treino?resumo=${encodeURIComponent(id)}`, {
        replaceUrl: true,
        state: { fromWorkout: true },
      });
    }
  }
}
