import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, ElementRef, computed, inject, input, signal } from '@angular/core';

/** Abaixo disto a diferença entre a janela e a área visível é barra de endereço, não teclado. */
const KEYBOARD_MIN_PX = 80;
/** Folga que o campo em foco precisa ter até a borda da área visível; sem ela, não há rolagem. */
const REVEAL_MARGIN_PX = 24;
/** Tempo para o teclado do celular terminar de subir antes de conferir se ele cobriu o campo. */
const KEYBOARD_SETTLE_MS = 300;
const VIEWPORT_SETTLE_MS = 100;
/**
 * Depois de a moldura rolar a página, por quanto tempo uma mudança da área visível é tida como efeito da própria
 * rolagem (no iPhone a barra do navegador encolhe ao rolar) e não pede outra: senão as duas brigam e a tela salta.
 */
const OWN_SCROLL_MS = 700;

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
    '[class.with-aside]': 'aside()',
  },
})
export class AuthLayout {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly doc = inject(DOCUMENT);
  private readonly win = this.doc.defaultView;
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  /** Até quando a página ainda está na rolagem que a própria moldura pediu (ver `OWN_SCROLL_MS`). */
  private ownScrollUntil = 0;

  /**
   * A página tem um segundo bloco (o QR de entrar pelo celular): na janela larga o cartão abre duas colunas, a primeira
   * com o conteúdo principal e a segunda com o bloco, para usar a largura sem esticar o formulário nem passar da altura.
   */
  readonly aside = input(false);

  /** As duas ondas do símbolo (mesma geometria do favicon). */
  protected readonly rightWave = 'M362.1 149.9A150 150 0 0 1 362.1 362.1';
  protected readonly leftWave = 'M149.9 149.9A150 150 0 0 0 149.9 362.1';

  /** Pixels da janela cobertos pelo teclado virtual (0 quando não há). */
  readonly keyboardInset = signal(0);
  protected readonly insetCss = computed(() => `${this.keyboardInset()}px`);

  constructor() {
    const viewport = this.win?.visualViewport;
    if (viewport) {
      // A rolagem da área visível (a da pessoa ou a nossa) só atualiza o espaço do teclado: quem pede outra revelação
      // é o teclado subindo ou descendo (`resize`), e nem ele enquanto a rolagem que a moldura fez não acabou.
      const onScroll = () => this.keyboardInset.set(this.measureInset(viewport));
      const onResize = () => {
        onScroll();
        if (this.focusedField() && Date.now() >= this.ownScrollUntil) {
          this.scheduleReveal(VIEWPORT_SETTLE_MS);
        }
      };
      viewport.addEventListener('resize', onResize);
      viewport.addEventListener('scroll', onScroll);
      inject(DestroyRef).onDestroy(() => {
        viewport.removeEventListener('resize', onResize);
        viewport.removeEventListener('scroll', onScroll);
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

  /**
   * Rola só se o campo (e, quando cabe junto, o botão de enviar) estiver cortado, em cima ou atrás
   * do teclado: no computador a página não se mexe. Com o botão à vista, quem termina de digitar envia sem fechar o
   * teclado; se os dois não cabem juntos, vale o campo, no meio da parte visível.
   */
  private reveal(): void {
    const field = this.focusedField();
    if (!field || !this.win) return;
    // Medido na parte visível: com o teclado aberto ela pode estar deslocada em relação à janela inteira.
    const viewport = this.win.visualViewport;
    const offset = viewport?.offsetTop ?? 0;
    const visibleHeight = viewport?.height ?? this.win.innerHeight;
    const box = field.getBoundingClientRect();
    // O botão que envia: o do formulário do campo ou, numa tela sem formulário, o marcado com `data-auth-submit`.
    const submit =
      field.form?.querySelector<HTMLElement>('[type="submit"]') ??
      this.host.nativeElement.querySelector<HTMLElement>('[data-auth-submit]');
    const end = submit?.getBoundingClientRect();
    const top = box.top - offset;
    const fieldBottom = box.bottom - offset;
    const both = end && end.bottom > box.bottom ? end.bottom - offset : fieldBottom;
    const room = visibleHeight - 2 * REVEAL_MARGIN_PX;
    const bottom = both - top <= room ? both : fieldBottom;
    if (top >= REVEAL_MARGIN_PX && bottom <= visibleHeight - REVEAL_MARGIN_PX) return;
    const calm = this.win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = calm ? 'auto' : 'smooth';
    this.ownScrollUntil = Date.now() + OWN_SCROLL_MS;
    if (bottom === fieldBottom) {
      field.scrollIntoView({ block: 'center', behavior });
      return;
    }
    // Campo e botão juntos (cabem, conferido acima): o campo desce até a margem de cima, ou o fim do botão sobe até a
    // margem de baixo da parte visível.
    const delta =
      top < REVEAL_MARGIN_PX ? top - REVEAL_MARGIN_PX : bottom - (visibleHeight - REVEAL_MARGIN_PX);
    this.win.scrollBy({ top: delta, behavior });
  }
}
