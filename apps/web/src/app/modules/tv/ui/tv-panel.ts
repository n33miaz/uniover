import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { TvStore } from '../data/tv-store';
import { TvIcon } from './tv-icon';

/** Quanto o dedo precisa arrastar o puxador para o painel fechar. */
const DRAG_CLOSE_PX = 72;

/** Quanto a folha desliza na saída: curto, só o bastante para dar sentido de descida (e de subida, na entrada, pelo CSS). */
const SHEET_OFFSET_PX = 24;

/**
 * Teto da espera pelo fim da transição de saída. A transição dura `--dur-base` (200 ms); se o `transitionend` não vier
 * (aba em segundo plano, navegador sem a transição), o painel fecha mesmo assim e a tela nunca fica presa.
 */
const LEAVE_TIMEOUT_MS = 300;

let nextPanelId = 0;

/**
 * Painel flutuante (modal) do controle: Apps e Teclado. É um `<dialog>` aberto com `showModal`, então o foco fica
 * preso nele, o resto da tela fica inerte e o Esc é tratado pelo navegador. Fecha com Esc, com toque fora do cartão,
 * arrastando o puxador (para baixo; para cima quando ancorado no topo) e, se `closable`, pelo botão do cabeçalho.
 * Entra com a folha subindo e o fundo esmaecendo; ao fechar faz o caminho inverso e só então avisa (`closed`), para a
 * página não tirar o painel no meio da saída. Sem animação (movimento reduzido, ou sem como medir) avisa na hora.
 * Ao fechar devolve o foco ao que o abriu. O aviso do `TvStore` aparece aqui dentro porque, com o painel aberto, o
 * aviso flutuante da tela fica atrás do fundo escurecido.
 */
@Component({
  selector: 'app-tv-panel',
  imports: [TvIcon],
  templateUrl: './tv-panel.html',
  styleUrl: './tv-panel.css',
  // O toque fora do cartão cai no próprio <dialog> e sobe até aqui; o equivalente de teclado é o Esc.
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '(click)': 'onClick($event)',
  },
})
export class TvPanel {
  protected readonly store = inject(TvStore);
  private readonly doc = inject(DOCUMENT);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** Título do painel (também o nome acessível do diálogo). */
  readonly heading = input.required<string>();
  /** `top` ancora o cartão no alto (o teclado do aparelho não o cobre); `bottom` o ancora embaixo. */
  readonly placement = input<'top' | 'bottom'>('bottom');
  /** Mostra o botão de fechar do cabeçalho; o painel pode ter o seu próprio "Fechar" no conteúdo. */
  readonly closable = input(true);
  /** Quem abriu o painel, para devolver o foco (o Safari não foca botão ao toque, então `activeElement` não basta). */
  readonly opener = input<HTMLElement | null>(null);
  readonly closed = output<void>();

  protected readonly titleId = `tv-panel-title-${nextPanelId++}`;
  protected readonly dragY = signal(0);
  protected readonly dragging = signal(false);
  /** Já pediram para fechar e a saída está rolando: o painel não aceita mais toque. */
  protected readonly leaving = signal(false);
  /**
   * O deslocamento vertical da folha. Segue o dedo no arrasto; na saída vai para fora na direção de fechar, a partir de
   * onde o dedo largou (nunca volta para trás). Fica em linha porque o arrasto precisa dele a cada quadro.
   */
  protected readonly transform = computed(() => {
    const dragged = this.dragY();
    if (!this.leaving()) return dragged === 0 ? null : `translateY(${dragged}px)`;
    const away = Math.max(Math.abs(dragged), SHEET_OFFSET_PX);
    return `translateY(${this.placement() === 'top' ? -away : away}px)`;
  });

  private readonly focusedBefore = this.doc.activeElement as HTMLElement | null;
  private emitted = false;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pressedOnBackdrop = false;
  private dragFrom: number | null = null;

  constructor() {
    this.store.clearNotice();
    afterNextRender(() => this.dialog().nativeElement.showModal());
    // O painel sai do DOM pela página (sem `close()`), então o navegador não devolve o foco sozinho.
    inject(DestroyRef).onDestroy(() => {
      this.clearLeaveTimer();
      const back = this.opener() ?? this.focusedBefore;
      if (back?.isConnected) back.focus({ preventScroll: true });
    });
  }

  /** Esc: quem tira o painel da tela é a página; impede o fechamento duplo do navegador. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  /**
   * Fechamento sem `cancel` (o Chromium fecha com Esc sem ele quando não houve interação): mantém o estado em dia. O
   * diálogo já saiu da tela, então não há saída a animar.
   */
  protected onNativeClose(): void {
    this.finish();
  }

  /** Pede o fechamento: a saída anima e, no fim dela, `closed` sai (uma vez só, venha o pedido de onde vier). */
  protected close(): void {
    if (this.emitted || this.leaving()) return;
    this.leaving.set(true);
    if (!this.animates()) {
      this.finish();
      return;
    }
    this.leaveTimer = setTimeout(() => this.finish(), LEAVE_TIMEOUT_MS);
  }

  /** O fim da transição de opacidade da folha (dura o mesmo que a de deslocamento) conclui a saída. */
  protected onCardTransitionEnd(event: TransitionEvent): void {
    if (
      this.leaving() &&
      event.target === event.currentTarget &&
      event.propertyName === 'opacity'
    ) {
      this.finish();
    }
  }

  /** Só anima quem não pediu menos movimento; sem `matchMedia` (testes em jsdom) também não há o que esperar. */
  private animates(): boolean {
    const query = this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    return !!query && !query.matches;
  }

  private clearLeaveTimer(): void {
    if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }

  private finish(): void {
    this.clearLeaveTimer();
    if (this.emitted) return;
    this.emitted = true;
    this.closed.emit();
  }

  /**
   * Toque fora do cartão (o `<dialog>` ocupa a tela toda): só vale se começou e terminou fora, para soltar uma
   * seleção de texto fora do cartão não fechar o painel.
   */
  protected onPointerDown(event: PointerEvent): void {
    this.pressedOnBackdrop = event.target === this.dialog().nativeElement;
  }

  protected onClick(event: MouseEvent): void {
    const outside = this.pressedOnBackdrop && event.target === this.dialog().nativeElement;
    this.pressedOnBackdrop = false;
    if (outside) this.close();
  }

  protected onGrabDown(event: PointerEvent): void {
    if (this.leaving() || !event.isPrimary || (event.target as Element).closest('button')) return;
    this.dragFrom = event.clientY;
    this.dragging.set(true);
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  }

  protected onGrabMove(event: PointerEvent): void {
    if (this.dragFrom === null) return;
    const delta = event.clientY - this.dragFrom;
    // Só acompanha o dedo no sentido de fechar: para baixo na folha de baixo, para cima na do topo.
    this.dragY.set(this.placement() === 'top' ? Math.min(0, delta) : Math.max(0, delta));
  }

  protected onGrabEnd(): void {
    if (this.dragFrom === null) return;
    const far = Math.abs(this.dragY()) >= DRAG_CLOSE_PX;
    this.dragFrom = null;
    this.dragging.set(false);
    if (far) this.close();
    else this.dragY.set(0);
  }
}
