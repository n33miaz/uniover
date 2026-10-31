import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { CatalogRepository } from '../data/catalog/catalog-repository';
import { BackNavigation, TRAINING_LOGICAL_PARENTS } from '../shell/back-navigation';
import { ExerciseHistory } from './exercise-history';
import { LiveSession } from './live-session';
import { LiveStore } from './live-store';
import { TodayStore } from './today-store';

/** A rota isolada do registro da série mantém a lista do treino como destino explícito do botão voltar. */
@Component({
  selector: 'app-workout-exercise',
  imports: [LiveSession],
  providers: [TodayStore, LiveStore, ExerciseHistory],
  template: `
    <app-live-session
      (exerciseCompleted)="backToDay()"
      (finished)="openSummary($event)"
      (discarded)="leave()"
    />
  `,
  encapsulation: ViewEncapsulation.None,
  styles: `
    app-workout-exercise {
      display: block;
    }

    app-training-page:has(app-workout-exercise) app-tab-bar {
      display: none !important;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkoutExercise {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly live = inject(LiveStore);
  private readonly catalog = inject(CatalogRepository);
  private readonly history = inject(BackNavigation);
  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });
  private selectedKey: string | null = null;

  constructor() {
    // A rota cria a tela de registro de novo; o item escolhido vem no endereço para a máquina escolhida não se perder.
    effect(() => {
      const key = this.params().get('exercicio');
      if (!this.live.ready() || key === null || key === this.selectedKey) return;
      this.selectedKey = key;
      untracked(() => void this.select(key));
    });
  }

  private async select(key: string): Promise<void> {
    if (key.startsWith('extra:')) {
      const exercise = await this.catalog.get(key.slice('extra:'.length));
      if (exercise !== undefined) await this.live.addExercise(exercise);
      return;
    }
    await this.live.choose(key);
  }

  protected backToDay(): void {
    this.history.back(TRAINING_LOGICAL_PARENTS.workoutExercise);
  }

  /** O resumo toma o lugar do registro no histórico, e o voltar dele (marcado por `state`) leva direto a Hoje. */
  protected openSummary(sessionId: string): void {
    void this.router.navigateByUrl(`/treino?resumo=${encodeURIComponent(sessionId)}`, {
      replaceUrl: true,
      state: { fromWorkout: true },
    });
  }

  protected leave(): void {
    void this.router.navigateByUrl('/treino');
  }
}
