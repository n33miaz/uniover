import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TvShortcut } from '../data/tv-types';
import { KeyButton, vibrate } from '../input/key-button';
import { StagePager } from '../input/stage-pager';
import { TouchpadSurface } from '../input/touchpad-surface';
import { DirectionalRing } from '../ui/directional-ring';
import { NumberPad } from '../ui/number-pad';
import { PageDots } from '../ui/page-dots';
import { ShortcutRow } from '../ui/shortcut-row';
import { TvIcon } from '../ui/tv-icon';

/** Páginas do palco central, nesta ordem: direções com o OK, números e, por último, o touchpad. */
const PAGE_COUNT = 3;

/** Onde a página do palco fica guardada enquanto a aba do navegador existir (recarregar não volta ao começo). */
const PAGE_KEY = 'uniover.tv.stage-page';

/** As partes de uma pílula: o botão que aumenta, o nível (ou o rótulo) e o botão que diminui. */
type PillPart = 'more' | 'level' | 'less';

/** Deslocamento do dedo (px) a partir do qual o gesto é arrasto, e não toque. */
const DRAG_SLOP_PX = 6;

/**
 * Controle principal (a tela única do módulo). Em cima, os atalhos favoritos da TV (azulejos quadrados que abrem o
 * app ao toque; o botão Apps fica no cabeçalho da tela); embaixo, as pílulas de volume e canal e os botões redondos. No meio fica o palco, e só ele
 * troca de página, deslizando, pelos pontos ou pelas setas do teclado: direções com o OK no centro, teclado numérico
 * e, por último, o touchpad (que engole o deslize dentro dele, então a volta é pela margem, pelos pontos ou pelo
 * teclado). O palco é um carrossel de rolagem com encaixe: o gesto é do próprio navegador e a `StagePager` cuida do
 * que ele não garante (indicador, página presa no meio, tamanho, abas, recarga). A rolagem horizontal da tela nunca
 * aparece. O Teclado não é tela: esta tela só avisa a página (`openKeyboard`) para abrir o painel flutuante. O que
 * Personalizar escolhe chega daqui: o tamanho dos botões de baixo (`--key-scale`), onde ficam as pílulas de volume e
 * canal (uma de cada lado dos botões redondos ou numa fileira acima deles), se as teclas de mídia e o canal aparecem
 * e com que página o palco abre.
 */
@Component({
  selector: 'app-tv-control',
  imports: [
    NgTemplateOutlet,
    KeyButton,
    TouchpadSurface,
    DirectionalRing,
    NumberPad,
    PageDots,
    ShortcutRow,
    TvIcon,
  ],
  templateUrl: './control.page.html',
  styleUrl: './control.page.css',
})
export class ControlPage {
  protected readonly store = inject(TvStore);
  protected readonly prefs = inject(TvPrefs);
  /** Abrir apps pelos atalhos de cima é de quem tem `tv:launch` (esta tela só existe para quem tem `tv:control`). */
  protected readonly canLaunch = inject(TvAccess).launch;
  private readonly pager = viewChild.required<ElementRef<HTMLElement>>('pager');

  /** Leva o botão tocado: o painel devolve o foco a ele ao fechar (o Safari não foca botão ao toque). */
  readonly openKeyboard = output<HTMLElement>();

  protected readonly pageCount = PAGE_COUNT;
  private readonly stage = new StagePager(
    {
      width: () => this.pager().nativeElement.clientWidth,
      left: () => this.pager().nativeElement.scrollLeft,
      scrollTo: (left, smooth) =>
        this.pager().nativeElement.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' }),
      reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    },
    PAGE_COUNT,
  );
  protected readonly page = this.stage.page;
  protected readonly progress = this.stage.progress;

  /** Só os atalhos ativos, na ordem da posição; o número do "Atalho n" é o da posição, que não muda. */
  protected readonly shortcuts = computed(() =>
    (this.store.shortcuts() ?? []).filter((shortcut) => shortcut.enabled),
  );

  /** As pílulas de volume e canal numa fileira deitada, acima dos botões redondos (Personalizar). */
  protected readonly rowPills = computed(() => this.prefs.pillLayout() === 'row');

  /**
   * As três partes de uma pílula na ordem em que aparecem (e em que o foco passa): em pé, mais em cima e menos embaixo;
   * deitada, menos à esquerda e mais à direita.
   */
  protected readonly pillParts = computed<readonly PillPart[]>(() =>
    this.rowPills() ? ['less', 'level', 'more'] : ['more', 'level', 'less'],
  );

  /**
   * Disposição dos botões redondos. Com as pílulas nas laterais: quatro colunas em duas fileiras; no tamanho grande,
   * quebra em três por fileira (não cabem mais quatro entre as pílulas numa tela estreita); sem as teclas de mídia
   * sobram quatro botões, em duas colunas. Com as pílulas em fileira os botões têm a largura toda: sempre quatro
   * colunas (uma fileira só, sem as teclas de mídia), até no tamanho grande.
   */
  protected readonly roundColumns = computed(() => {
    if (this.rowPills()) return 4;
    if (!this.prefs.showMedia()) return 2;
    return this.prefs.buttonSize() === 'large' ? 3 : 4;
  });

  protected readonly volumeText = computed(() => {
    const volume = this.store.state()?.volume;
    return volume === null || volume === undefined ? '–' : String(volume);
  });
  /** Quanto da pílula de volume se enche (0 a 100); sem nível conhecido fica vazia. */
  protected readonly volumePercent = computed(() => {
    const volume = this.store.state()?.volume;
    return volume === null || volume === undefined ? 0 : Math.min(100, Math.max(0, volume));
  });
  protected readonly volumeLabel = computed(() => {
    const volume = this.store.state()?.volume;
    return volume === null || volume === undefined
      ? $localize`:@@tv.volume.unknown:Volume desconhecido`
      : $localize`:@@tv.volume.level:Volume ${volume}:level:`;
  });

  protected askKeyboard(event: Event): void {
    this.openKeyboard.emit(event.currentTarget as HTMLElement);
  }

  protected openShortcut(shortcut: TvShortcut): void {
    if (!this.store.canSend() || !this.canLaunch()) return;
    vibrate();
    void this.store.launch(shortcut);
  }

  protected pageLabel(index: number): string {
    const number = index + 1;
    const total = PAGE_COUNT;
    return $localize`:@@tv.pager.page:Página ${number}:number: de ${total}:total:`;
  }

  /** Acompanha a rolagem (gesto, inércia, encaixe ou pedido) para o ponto e o indicador. */
  protected onScroll(): void {
    this.stage.scrolled();
  }

  protected goTo(index: number): void {
    this.stage.goTo(index);
  }

  /** Setas, Início e Fim com o foco no próprio palco trocam a página; com o foco num botão ou no touchpad, não. */
  protected onKey(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    const page = this.page();
    const target =
      event.key === 'ArrowRight'
        ? page + 1
        : event.key === 'ArrowLeft'
          ? page - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? PAGE_COUNT - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    this.goTo(target);
  }

  constructor() {
    const restored = this.startPage();
    effect(() => writeSavedPage(this.page()));

    afterNextRender(() => {
      const element = this.pager().nativeElement;
      if (restored > 0) this.stage.restore(restored);

      // Ouvintes passivos: um ouvinte de toque que pudesse bloquear seguraria a rolagem do carrossel.
      let startX = 0;
      const down = (event: TouchEvent) => {
        startX = event.touches[0]?.clientX ?? 0;
        this.stage.touchStart(startX, event.timeStamp);
      };
      const move = (event: TouchEvent) => {
        const x = event.touches[0]?.clientX ?? startX;
        if (Math.abs(x - startX) > DRAG_SLOP_PX) this.stage.touchDragged(x, event.timeStamp);
      };
      const up = (event: TouchEvent) => this.stage.touchEnd(event.timeStamp);
      const options = { passive: true } as const;
      element.addEventListener('touchstart', down, options);
      element.addEventListener('touchmove', move, options);
      element.addEventListener('touchend', up, options);
      element.addEventListener('touchcancel', up, options);

      // A página escolhida tem de continuar à vista depois de girar a tela, redimensionar e voltar de outra aba.
      const realign = () => this.stage.realign();
      const onVisible = () => {
        if (document.visibilityState === 'visible') realign();
      };
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(realign) : null;
      observer?.observe(element);
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('pageshow', realign);

      this.cleanup = () => {
        element.removeEventListener('touchstart', down);
        element.removeEventListener('touchmove', move);
        element.removeEventListener('touchend', up);
        element.removeEventListener('touchcancel', up);
        observer?.disconnect();
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('pageshow', realign);
      };
    });

    inject(DestroyRef).onDestroy(() => {
      this.cleanup();
      this.stage.destroy();
    });
  }

  private cleanup: () => void = () => undefined;

  /** A página com que o palco abre: a escolhida em Personalizar ou, em "última usada", a que ficou nesta aba. */
  private startPage(): number {
    switch (this.prefs.startPage()) {
      case 'directions':
        return 0;
      case 'numbers':
        return 1;
      case 'touchpad':
        return 2;
      case 'last':
        return readSavedPage();
    }
  }
}

function readSavedPage(): number {
  try {
    const saved = Number(sessionStorage.getItem(PAGE_KEY));
    return Number.isInteger(saved) && saved > 0 && saved < PAGE_COUNT ? saved : 0;
  } catch {
    return 0;
  }
}

function writeSavedPage(page: number): void {
  try {
    sessionStorage.setItem(PAGE_KEY, String(page));
  } catch {
    // sem armazenamento (modo privado, bloqueado): a página só não é lembrada
  }
}
