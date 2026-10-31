import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CHART_ENGINE } from './chart-engine';
import type { ChartHandle, ChartSpec } from './chart-types';

/** Largura de partida quando o navegador não sabe medir (testes): o gráfico só precisa de um número. */
const FALLBACK_WIDTH = 300;

/**
 * O desenho do gráfico de linha. Só desenha: o texto que o descreve (resumo, valor do ponto, tabela) é da tela que o usa,
 * porque canvas não tem texto para o leitor de tela e por isso fica fora da árvore de acessibilidade.
 *
 * O desenho é criado na primeira vez que há o que desenhar (`CHART_ENGINE`); enquanto isso o espaço fica reservado (sem
 * salto na tela). Se a biblioteca não conseguir iniciar (sem canvas, por exemplo), avisa por `failed` e a tela mostra a
 * tabela. A largura acompanha o cartão (girar o aparelho, abrir a tela dividida).
 */
@Component({
  selector: 'app-progress-line-chart',
  template: `<div
    #host
    class="plot"
    [class.ui-skeleton]="!ready()"
    [class.ui-wait]="!ready()"
    aria-hidden="true"
  ></div>`,
  styleUrl: './line-chart.css',
  // O DOM do gráfico é criado pela biblioteca, fora do modelo: estilo encapsulado não o alcançaria.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressLineChart {
  private readonly engine = inject(CHART_ENGINE);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  readonly spec = input.required<ChartSpec>();
  /** O toque escolheu um ponto (índice na lista do gráfico). */
  readonly picked = output<number>();
  /** A biblioteca não conseguiu iniciar o desenho. */
  readonly failed = output<void>();

  protected readonly ready = signal(false);

  private handle: ChartHandle | null = null;
  private observer: ResizeObserver | null = null;
  private width = 0;
  private creating = false;
  private destroyed = false;

  constructor() {
    afterNextRender(() => this.start());
    effect(() => {
      const spec = this.spec();
      untracked(() => this.handle?.update(spec));
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.observer?.disconnect();
      this.handle?.destroy();
      this.handle = null;
    });
  }

  private start(): void {
    const element = this.host().nativeElement;
    if (typeof ResizeObserver === 'undefined') {
      void this.create(element, FALLBACK_WIDTH);
      return;
    }
    // A primeira medida válida cria o gráfico; as seguintes só mudam a largura.
    this.observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (next <= 0 || next === this.width) return;
      this.width = next;
      if (this.handle) this.handle.setWidth(next);
      else void this.create(element, next);
    });
    this.observer.observe(element);
  }

  private async create(element: HTMLElement, width: number): Promise<void> {
    if (this.handle !== null || this.creating) return;
    this.creating = true;
    try {
      const handle = await this.engine.create(element, untracked(this.spec), width, {
        onPick: (index) => this.picked.emit(index),
      });
      if (this.destroyed) {
        handle.destroy();
        return;
      }
      this.handle = handle;
      // O que mudou enquanto a biblioteca carregava: os dados e a largura.
      handle.update(untracked(this.spec));
      if (this.width > 0 && this.width !== width) handle.setWidth(this.width);
      this.ready.set(true);
    } catch {
      if (!this.destroyed) this.failed.emit();
    } finally {
      this.creating = false;
    }
  }
}
