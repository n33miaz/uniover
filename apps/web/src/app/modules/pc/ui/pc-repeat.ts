import { DestroyRef, Directive, inject, input, output } from '@angular/core';
import { HoldRepeater } from '../../../shared/input/hold-repeater';
import { RepeatBatcher } from '../input/repeat-batcher';

/** Depois de quanto tempo segurando a tecla começa a repetir, e de quanto em quanto tempo repete. */
export const REPEAT_AFTER_MS = 420;
export const REPEAT_EVERY_MS = 140;

/**
 * Botão que age ao toque e, se o dedo ficar, repete até soltar (apagar, setas). A primeira ação é do toque; a ativação
 * pelo teclado ou leitor de tela (clique sem ponteiro) age uma vez. `repeatSkip` deixa uma rodada passar sem agir quando já há
 * pedidos demais sem resposta: a fila do PC anda uma tecla por ida e volta, e sem esse freio o PC seguiria apagando
 * depois de o dedo sair.
 */
@Directive({
  selector: '[appPcRepeat]',
  host: {
    '(pointerdown)': 'down($event)',
    '(pointerup)': 'stop()',
    '(pointercancel)': 'stop()',
    '(pointerleave)': 'stop()',
    '(click)': 'click($event)',
    '(contextmenu)': '$event.preventDefault()',
  },
})
export class PcRepeat {
  /** Cada ação: a do toque e as repetições. */
  readonly appPcRepeat = output<void>();
  /** Quando devolve `true`, a repetição daquela rodada não age. */
  readonly repeatSkip = input<() => boolean>(() => false);
  /**
   * Em lotes: o PC entende `pc.key.v2`, então segurar manda um pedido a cada rodada com `repeat` (`repeatMany`) em vez de um
   * por repetição. Decidido no toque. Sem isso, a repetição é a de sempre (`appPcRepeat`, uma por rodada).
   */
  readonly batched = input(false);
  /** Quantas repetições juntas saem neste pedido (só no modo em lotes). */
  readonly repeatMany = output<number>();

  private readonly repeater = new HoldRepeater(
    () => this.appPcRepeat.emit(),
    REPEAT_AFTER_MS,
    REPEAT_EVERY_MS,
    () => this.repeatSkip()(),
  );

  private readonly batcher = new RepeatBatcher(
    (count) => this.repeatMany.emit(count),
    () => this.repeatSkip()(),
  );
  private delayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  protected down(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.stop();
    this.appPcRepeat.emit();
    if (this.batched()) {
      // A primeira ação é do toque; depois do atraso, um pedido por rodada com as repetições devidas.
      this.delayTimer = setTimeout(() => {
        this.delayTimer = undefined;
        this.batcher.start();
      }, REPEAT_AFTER_MS);
    } else {
      this.repeater.start();
    }
  }

  protected stop(): void {
    this.repeater.stop();
    this.batcher.stop();
    clearTimeout(this.delayTimer);
    this.delayTimer = undefined;
  }

  /** `detail === 0` é a ativação sem ponteiro (teclado, leitor de tela); o clique do dedo já agiu no `pointerdown`. */
  protected click(event: MouseEvent): void {
    if (event.detail === 0) this.appPcRepeat.emit();
  }
}
