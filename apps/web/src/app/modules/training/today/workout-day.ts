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
import type { LocalExercise } from '../data/catalog/exercise';
import { WakeLockService } from '../data/session-live/wake-lock.service';
import { illustrationFor, illustrationUrl } from '../illustrations/illustration-map';
import { TrainingGlyph } from '../shell/training-glyph';
import { ExerciseHistory } from './exercise-history';
import { ExerciseChooserSheet } from './exercise-chooser-sheet';
import { LiveStore } from './live-store';
import { type MenuAction, SessionMenuSheet } from './session-menu-sheet';
import { TodayGlyph } from './today-glyph';
import { TodayStore } from './today-store';
import { awaitingSetsText } from './today-text';

/**
 * A escolha do exercício durante um treino aberto. Ela deixa a pessoa trocar de máquina sem reordenar a rotina nem
 * esconder o que já foi concluído; a próxima sugestão continua sendo apenas um atalho, nunca uma obrigação. As opções
 * do treino (tela acesa, adicionar, terminar, cancelar) ficam no menu do topo, como na tela de registro.
 */
@Component({
  selector: 'app-workout-day',
  imports: [RouterLink, TrainingGlyph, TodayGlyph, ExerciseChooserSheet, SessionMenuSheet],
  providers: [TodayStore, LiveStore, ExerciseHistory],
  template: `
    <section class="day" aria-labelledby="workout-title">
      <header class="head">
        <a
          routerLink="/treino"
          class="circle ui-tap"
          aria-label="Voltar a Hoje"
          i18n-aria-label="@@training.day.back"
        >
          <app-training-glyph name="back" />
        </a>
        <h1 id="workout-title" i18n="@@training.day.title">Treino</h1>
        <button
          type="button"
          class="circle ui-tap"
          [attr.aria-haspopup]="'dialog'"
          [attr.aria-label]="menuLabel"
          (click)="menuOpen.set(true)"
        >
          <app-today-glyph name="dots" />
        </button>
      </header>

      @if (awaitingText(); as waiting) {
        <p class="sending">
          <app-training-glyph name="hourglass" />
          <span>{{ waiting }}</span>
        </p>
      }

      @if (live.ready() && live.session() === undefined) {
        <section class="empty ui-card" aria-labelledby="empty-title">
          <span class="ui-tile lg"><app-training-glyph name="info" /></span>
          <h2 id="empty-title" i18n="@@training.day.empty-title">Treino Não Encontrado</h2>
          <a routerLink="/treino" class="primary ui-btn" i18n="@@training.day.empty-back"
            >Voltar a Hoje</a
          >
        </section>
      } @else {
        <p class="routine-name">{{ live.workoutName() }}</p>

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
                <span class="name">{{
                  live.exercises().get(entry.exerciseId)?.name ?? unknownName
                }}</span>
                <span class="meta">{{
                  progressText(entry.doneSets, entry.targetSets, entry.skipped)
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

    @if (menuOpen()) {
      <app-session-menu-sheet
        [showPlan]="false"
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
  styles: `
    app-training-page:has(app-workout-day) .training-header,
    app-training-page:has(app-workout-day) app-tab-bar,
    app-training-page:has(app-workout-day) app-training-sync-line,
    app-training-page:has(app-workout-exercise) .training-header,
    app-training-page:has(app-workout-exercise) app-tab-bar,
    app-training-page:has(app-workout-exercise) app-training-sync-line {
      display: none !important;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkoutDay {
  protected readonly live = inject(LiveStore);
  private readonly today = inject(TodayStore);
  private readonly router = inject(Router);
  private readonly wake = inject(WakeLockService);

  protected readonly menuLabel = $localize`:@@training.live.menu:Opções do treino`;
  protected readonly unknownName = $localize`:@@training.day.unknown:Exercício removido`;
  protected readonly chooseHeading = $localize`:@@training.day.choose-title:Adicionar Exercício`;
  protected readonly chooserOpen = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly screenRefused = signal(false);
  protected readonly screenSupported = this.wake.supported;
  protected readonly screenOn = this.wake.active;
  /** "3 séries aguardando envio": sem rede é o estado normal, e a tela do dia também o mostra. */
  protected readonly awaitingText = computed(() => awaitingSetsText(this.today.awaitingSets()));
  protected readonly suggestedKey = computed(() => this.live.focus()?.key ?? null);
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
    // A tela acesa vale só enquanto o treino está aberto na tela: sair do treino solta o bloqueio.
    inject(DestroyRef).onDestroy(() => void this.wake.release());
  }

  protected art(exerciseId: string): string | null {
    const exercise = this.live.exercises().get(exerciseId);
    const art = exercise ? illustrationFor(exercise.slug) : undefined;
    return art ? illustrationUrl(art.frames[0]) : null;
  }

  protected complete(entry: {
    readonly doneSets: number;
    readonly targetSets: number | null;
  }): boolean {
    return entry.targetSets !== null && entry.doneSets >= entry.targetSets;
  }

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

  protected async openExtra(exercise: LocalExercise): Promise<void> {
    this.chooserOpen.set(false);
    await this.router.navigate(['/treino/sessao/exercicio'], {
      queryParams: { exercicio: `extra:${exercise.id}` },
    });
  }

  protected async onMenu(action: MenuAction): Promise<void> {
    switch (action) {
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
