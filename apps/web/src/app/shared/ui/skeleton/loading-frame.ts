import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  InjectionToken,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

/** Até quando a espera brilha: passado o teto, o brilho dá lugar a um aviso com "Tentar de Novo". */
export interface LoadingTiming {
  readonly giveUpAfterMs: number;
}

export const LOADING_TIMING = new InjectionToken<LoadingTiming>('LOADING_TIMING', {
  providedIn: 'root',
  factory: () => ({ giveUpAfterMs: 20_000 }),
});

/**
 * O que "Tentar de Novo" faz quando a tela não tem uma leitura própria para refazer: recarregar a página, que reabre o
 * banco local e refaz tudo. Um token para o teste trocar por um espião.
 */
export const LOADING_RELOAD = new InjectionToken<() => void>('LOADING_RELOAD', {
  providedIn: 'root',
  factory: () => {
    const doc = inject(DOCUMENT);
    return () => doc.location.reload();
  },
});

/**
 * A moldura de toda espera por dado: cada tela entrega só as formas dela (`appSkeleton`, o brilho único do app) e a moldura
 * cuida do resto, igual em todas:
 * - as formas ocupam o lugar desde o primeiro quadro, mas só se mostram depois de uma fração de segundo (`ui-wait`): uma
 *   resposta rápida não pisca, e o que chega depois ocupa o mesmo lugar, sem pulo;
 * - o leitor de tela ouve só o texto (`label`), nunca as formas;
 * - passado o teto (`LOADING_TIMING`) o brilho para: um brilho que nunca acaba parece travado. Vira um aviso curto com
 *   "Tentar de Novo", que refaz a leitura (`retried`) ou, sem leitura própria (`reload`), recarrega a página. Depois de
 *   tentar de novo o relógio recomeça, então a espera nunca fica em laço sem dizer nada.
 * Quem usa põe a moldura num `@if` e a tira quando o dado chega; ela some junto, com o relógio.
 */
@Component({
  selector: 'app-loading-frame',
  host: { '[attr.aria-busy]': "gaveUp() ? null : 'true'" },
  template: `
    @if (gaveUp()) {
      <div class="ui-notice bad give-up" role="alert">
        <p i18n="@@shared.loading.slow">Está demorando mais do que o normal.</p>
        <button type="button" class="secondary ui-btn" (click)="retry()">
          <span i18n="@@shared.loading.retry">Tentar de Novo</span>
        </button>
      </div>
    } @else {
      <span class="ui-visually-hidden" role="status">{{ label() }}</span>
      <div class="shape ui-wait" aria-hidden="true">
        <ng-content />
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .give-up {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }
    .give-up p {
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingFrame {
  /** O que o leitor de tela ouve enquanto espera ("Carregando as rotinas…"). */
  readonly label = input.required<string>();
  /** Sem leitura própria para refazer, "Tentar de Novo" recarrega a página; quem tem a leitura fecha isto e ouve `retried`. */
  readonly reload = input(true);
  /** "Tentar de Novo" foi tocado: a tela refaz a leitura dela. */
  readonly retried = output<void>();

  private readonly timing = inject(LOADING_TIMING);
  private readonly doReload = inject(LOADING_RELOAD);
  private readonly doc = inject(DOCUMENT);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly gaveUp = signal(false);

  constructor() {
    this.startClock();
    // A cobertura de abertura espera a primeira forma da página. Assim, quando uma leitura demorar,
    // a troca entre os dois esqueletos não expõe o fundo vazio por um quadro.
    afterNextRender(() => this.doc.dispatchEvent(new Event('uniover:page-ready')));
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected retry(): void {
    this.gaveUp.set(false);
    this.startClock();
    this.retried.emit();
    if (this.reload()) this.doReload();
  }

  private startClock(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.gaveUp.set(true), this.timing.giveUpAfterMs);
  }
}
