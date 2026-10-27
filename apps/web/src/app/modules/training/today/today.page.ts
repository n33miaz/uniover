import { toSignal } from '@angular/core/rxjs-interop';
import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { BackNavigation } from '../shell/back-navigation';
import { ExerciseHistory } from './exercise-history';
import { LiveSession } from './live-session';
import { LiveStore } from './live-store';
import { SessionSummary } from './session-summary';
import { TodayHome } from './today-home';
import { TodayStore } from './today-store';

/** Onde fica, no endereço, a visão do treino ao vivo e a do resumo (o treino em si vive no banco local). */
export const LIVE_PARAM = 'sessao';
export const LIVE_VALUE = 'ao-vivo';
export const SUMMARY_PARAM = 'resumo';
export const HISTORY_PARAM = 'historico';

/**
 * A aba Hoje. Uma só rota com três visões: o dia (resumo da semana e rotina), o treino ao vivo e o resumo ao terminar.
 * A visão fica no endereço (`?sessao=ao-vivo`, `?resumo=<treino>`): o botão voltar e o recarregar funcionam, e o que a
 * tela mostra vem sempre do banco local, nunca de variáveis soltas.
 *
 * O treino ao vivo e o resumo ocupam a tela inteira: enquanto estão abertos, a barra de abas e o cabeçalho do módulo
 * somem (a tela tem o seu cabeçalho e o seu botão principal fixo embaixo). Quem fecha a visão devolve a casca.
 */
@Component({
  selector: 'app-training-today-page',
  imports: [TodayHome, LiveSession, SessionSummary],
  providers: [TodayStore, LiveStore, ExerciseHistory],
  host: { '[attr.data-focus]': "focused() ? '' : null" },
  template: `
    @if (!store.ready()) {
      <div class="ui-card waiting" aria-hidden="true"><span class="ui-skeleton"></span></div>
    } @else if (summaryId(); as id) {
      <app-session-summary [sessionId]="id" [showSets]="historyOpen()" (done)="leave()" />
    } @else if (liveOpen()) {
      <app-live-session (back)="leave()" (finished)="openSummary($event)" (discarded)="leave()" />
    } @else {
      <app-today-home (started)="openLive()" />
    }
  `,
  // Sem encapsulamento de propósito: a regra mira a barra de abas e o cabeçalho da casca do app, fora deste componente.
  encapsulation: ViewEncapsulation.None,
  styles: `
    app-training-today-page .waiting {
      display: flex;
      align-items: center;
      min-height: 72px;
      padding: var(--space-4);
    }

    app-training-today-page .waiting .ui-skeleton {
      width: 62%;
      height: 18px;
    }

    body:has(app-training-today-page[data-focus]) app-tab-bar,
    body:has(app-training-today-page[data-focus]) app-shell > header {
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

  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });

  /** A primeira leitura do treino aberto já aconteceu e o endereço foi conferido (uma vez só). */
  private readonly checked = signal(false);
  /** O endereço pedia o treino ao vivo, mas não há treino aberto neste aparelho. */
  private readonly stale = signal(false);

  protected readonly summaryId = computed(() => this.params().get(SUMMARY_PARAM));
  /** O calendário abre o histórico já com as séries visíveis; ao concluir agora, elas continuam atrás do botão de edição. */
  protected readonly historyOpen = computed(() => this.params().get(HISTORY_PARAM) === '1');
  /**
   * O treino ao vivo abre pelo endereço. Depois da primeira conferência ele só depende do endereço: terminar ou cancelar o
   * treino muda o endereço (resumo ou Hoje), e a tela não pode sair do lugar por conta própria no meio dessa troca.
   */
  protected readonly liveOpen = computed(
    () => this.params().get(LIVE_PARAM) === LIVE_VALUE && this.checked() && !this.stale(),
  );
  protected readonly focused = computed(
    () => this.store.ready() && (this.summaryId() !== null || this.liveOpen()),
  );

  constructor() {
    // Um endereço velho (recarregou depois de o treino acabar, ou o link é antigo) cai em Hoje. Só confere na primeira leitura.
    effect(() => {
      if (!this.store.ready() || this.checked()) return;
      untracked(() => {
        const stale =
          this.params().get(LIVE_PARAM) === LIVE_VALUE && this.store.active() === undefined;
        this.stale.set(stale);
        this.checked.set(true);
        // Com o endereço limpo, um treino aberto depois (pelo botão de iniciar) volta a poder abrir a tela ao vivo.
        if (stale) void this.go({ [LIVE_PARAM]: null }, true).then(() => this.stale.set(false));
      });
    });
  }

  protected openLive(): void {
    void this.go({ [LIVE_PARAM]: LIVE_VALUE, [SUMMARY_PARAM]: null, [HISTORY_PARAM]: null }, false);
  }

  protected openSummary(sessionId: string): void {
    void this.go({ [LIVE_PARAM]: null, [SUMMARY_PARAM]: sessionId, [HISTORY_PARAM]: null }, true);
  }

  /** Fecha a visão (o treino ao vivo ou o resumo) e volta ao dia: uma entrada atrás do histórico, ou Hoje direto. */
  protected leave(): void {
    this.back.back('/treino');
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
