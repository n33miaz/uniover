import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, ElementRef, computed, inject, signal } from '@angular/core';

/** Abaixo disto a diferença entre a janela e a área visível é barra de endereço, não teclado. */
const KEYBOARD_MIN_PX = 80;
/** Folga que o campo em foco precisa ter até a borda da área visível; sem ela, não há rolagem. */
const REVEAL_MARGIN_PX = 24;
/** Tempo para o teclado do celular terminar de subir antes de conferir se ele cobriu o campo. */
const KEYBOARD_SETTLE_MS = 300;
const VIEWPORT_SETTLE_MS = 100;

/**
 * Moldura comum das telas de entrada e de convite (que ficam fora da casca do app): a marca no alto, o cartão
 * central e, no celular, dois cuidados que a página sozinha não tem.
 *
 * - Teclado virtual: o navegador do celular não encolhe a página quando o teclado sobe, ele só cobre a parte de
 *   baixo. Por isso a moldura mede quanto da janela ficou coberta (`visualViewport`), devolve esse valor como
 *   espaço no fim da página (`--kb-inset`) e, ao focar um campo, rola até ele aparecer inteiro na parte visível.
 * - Áreas seguras: o recorte, a barra de gestos e as laterais em paisagem ficam livres (`env(safe-area-inset-*)`).
 */
@Component({
  selector: 'app-auth-layout',
  templateUrl: './auth-layout.html',
  styleUrl: './auth-layout.css',
  host: {
    '(focusin)': 'onFocusIn($event)',
    '[style.--kb-inset]': 'insetCss()',
  },
})
export class AuthLayout {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly doc = inject(DOCUMENT);
  private readonly win = this.doc.defaultView;
  private revealTimer: ReturnType<typeof setTimeout> | undefined;

  /** As duas ondas do símbolo (mesma geometria do favicon). */
  protected readonly rightWave = 'M362.1 149.9A150 150 0 0 1 362.1 362.1';
  protected readonly leftWave = 'M149.9 149.9A150 150 0 0 0 149.9 362.1';

  /** Pixels da janela cobertos pelo teclado virtual (0 quando não há). */
  readonly keyboardInset = signal(0);
  protected readonly insetCss = computed(() => `${this.keyboardInset()}px`);

  constructor() {
    const viewport = this.win?.visualViewport;
    if (viewport) {
      const onViewport = () => {
        this.keyboardInset.set(this.measureInset(viewport));
        if (this.focusedField()) this.scheduleReveal(VIEWPORT_SETTLE_MS);
      };
      viewport.addEventListener('resize', onViewport);
      viewport.addEventListener('scroll', onViewport);
      inject(DestroyRef).onDestroy(() => {
        viewport.removeEventListener('resize', onViewport);
        viewport.removeEventListener('scroll', onViewport);
      });
    }
    inject(DestroyRef).onDestroy(() => clearTimeout(this.revealTimer));
  }

  protected onFocusIn(event: FocusEvent): void {
    if (event.target instanceof HTMLInputElement) this.scheduleReveal(KEYBOARD_SETTLE_MS);
  }

  private measureInset(viewport: VisualViewport): number {
    const covered = (this.win?.innerHeight ?? 0) - viewport.height - viewport.offsetTop;
    return covered >= KEYBOARD_MIN_PX ? Math.round(covered) : 0;
  }

  private focusedField(): HTMLInputElement | null {
    const active = this.doc.activeElement;
    return active instanceof HTMLInputElement && this.host.nativeElement.contains(active)
      ? active
      : null;
  }

  private scheduleReveal(delay: number): void {
    clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => this.reveal(), delay);
  }

  /** Rola só se o campo estiver cortado (em cima, ou atrás do teclado): no computador a página não se mexe. */
  private reveal(): void {
    const field = this.focusedField();
    if (!field || !this.win) return;
    // Medido na parte visível: com o teclado aberto ela pode estar deslocada em relação à janela inteira.
    const viewport = this.win.visualViewport;
    const offset = viewport?.offsetTop ?? 0;
    const visibleHeight = viewport?.height ?? this.win.innerHeight;
    const box = field.getBoundingClientRect();
    const top = box.top - offset;
    const bottom = box.bottom - offset;
    if (top >= REVEAL_MARGIN_PX && bottom <= visibleHeight - REVEAL_MARGIN_PX) return;
    const calm = this.win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    field.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  }
}
