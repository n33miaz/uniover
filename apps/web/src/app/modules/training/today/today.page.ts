import { toSignal } from '@angular/core/rxjs-interop';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { BackNavigation } from '../shell/back-navigation';
import { TrainingHeaderActions } from '../shell/training-header-actions';
import { ExerciseHistory } from './exercise-history';
import { LiveStore } from './live-store';
import { SessionSummary } from './session-summary';
import { TodayHome } from './today-home';
import { TodaySkeleton } from './today-skeleton';
import { TodayStore } from './today-store';
import { SessionSummarySkeleton } from './workout-skeletons';

/** Onde fica, no endereço, a visão do treino ao vivo e a do resumo (o treino em si vive no banco local). */
export const LIVE_PARAM = 'sessao';
export const LIVE_VALUE = 'ao-vivo';
export const SUMMARY_PARAM = 'resumo';
export const HISTORY_PARAM = 'historico';

/** O atraso do esqueleto compartilhado (`--wait-delay` em styles.css), em milissegundos. */
const SKELETON_DELAY_MS = 200;

/**
 * A aba Hoje mostra o dia e o resumo histórico (`?resumo=<treino>`). A sessão aberta vive em rotas próprias, para que a
 * lista de exercícios seja um destino claro ao voltar do registro de uma série.
 *
 * O treino ao vivo e o resumo ocupam a tela inteira: enquanto estão abertos, a barra de abas e o cabeçalho do módulo
 * somem (a tela tem o seu cabeçalho e o seu botão principal fixo embaixo). Quem fecha a visão devolve a casca.
 */
@Component({
  selector: 'app-training-today-page',
  imports: [TodayHome, SessionSummary, SessionSummarySkeleton, TodaySkeleton],
  providers: [TodayStore, LiveStore, ExerciseHistory],
  host: {
    '[attr.data-focus]': "summaryId() !== null ? '' : null",
    // Passado o atraso de uma espera, a seguinte (a de Hoje depois desta) já se mostra de uma vez: se cada uma esperasse o
    // próprio atraso, haveria um vazio entre as duas.
    '[style.--wait-delay]': "waited() ? '0ms' : null",
  },
  template: `
    @if (!store.ready()) {
      @if (summaryId() !== null) {
        <app-session-summary-skeleton />
      } @else {
        <app-today-skeleton [withWeek]="true" />
      }
    } @else if (summaryId(); as id) {
      <app-session-summary [sessionId]="id" [showSets]="historyOpen()" (done)="leave()" />
    } @else {
      <app-today-home (started)="openWorkout()" />
    }
  `,
  // Sem encapsulamento de propósito: a regra mira a barra de abas e o cabeçalho da casca do app, fora deste componente.
  encapsulation: ViewEncapsulation.None,
  styles: `
    body:has(app-training-today-page[data-focus]) app-tab-bar,
    body:has(app-training-today-page[data-focus]) app-shell > header,
    app-training-page:has(app-training-today-page[data-focus]) app-training-sync-line {
      display: none !important;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TodayPage {
  protected readonly store = inject(TodayStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly back = inject(BackNavigation);
  private readonly location = inject(Location);
  private readonly headerActions = inject(TrainingHeaderActions);

  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });

  /** A espera pela leitura local já passou do atraso em que o esqueleto aparece. */
  protected readonly waited = signal(false);
  private readonly settled = computed(() => this.store.ready() && this.store.homeReady());

  /** A primeira leitura do treino aberto já aconteceu e o endereço foi conferido (uma vez só). */
  private readonly checked = signal(false);

  protected readonly summaryId = computed(() => this.params().get(SUMMARY_PARAM));
  /** O calendário abre o histórico já com as séries visíveis; ao concluir agora, elas continuam atrás do botão de edição. */
  protected readonly historyOpen = computed(() => this.params().get(HISTORY_PARAM) === '1');
  constructor() {
    const timer = setTimeout(() => {
      if (!this.settled()) this.waited.set(true);
    }, SKELETON_DELAY_MS);
    // Pronto o dia, a marca cai: o que esperar depois (uma folha, uma lista) volta a respeitar o atraso.
    effect(() => {
      if (this.settled()) untracked(() => this.waited.set(false));
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
    // O resumo é uma tela aberta sobre Hoje: a única seta do topo fecha o resumo (e não sai de Hoje para o Início).
    effect((onCleanup) => {
      if (this.summaryId() === null) return;
      onCleanup(this.headerActions.registerBack(() => this.leave()));
    });
    // Um endereço antigo da sessão ao vivo cai em Hoje; a sessão atual tem uma rota própria.
    effect(() => {
      if (!this.store.ready() || this.checked()) return;
      untracked(() => {
        this.checked.set(true);
        if (this.params().get(LIVE_PARAM) === LIVE_VALUE) {
          void this.go({ [LIVE_PARAM]: null }, true);
        }
      });
    });
  }

  protected openWorkout(): void {
    void this.router.navigateByUrl('/treino/sessao');
  }

  /** Fecha a visão (o treino ao vivo ou o resumo) e volta ao dia: uma entrada atrás do histórico, ou Hoje direto. */
  protected leave(): void {
    // O resumo de um treino que acabou de terminar volta direto a Hoje (atrás dele no histórico está a tela do dia, de um
    // treino que já não existe); o do calendário volta ao que estava antes.
    const state = this.location.getState() as { fromWorkout?: boolean } | null;
    if (state?.fromWorkout === true)
      void this.router.navigateByUrl('/treino', { replaceUrl: true });
    else this.back.back('/treino');
  }

  private go(queryParams: Record<string, string | null>, replaceUrl: boolean): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }
}
