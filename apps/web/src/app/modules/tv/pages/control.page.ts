import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TvStore } from '../data/tv-store';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { KeyButton } from '../input/key-button';
import { TouchpadSurface } from '../input/touchpad-surface';
import { DirectionalRing } from '../ui/directional-ring';
import { NumberPad } from '../ui/number-pad';
import { PageDots } from '../ui/page-dots';
import { TvIcon } from '../ui/tv-icon';

type RemoteMode = 'buttons' | 'touchpad';

const PAGE_COUNT = 2;

/**
 * Aba Controle. Em cima, os atalhos (ou os chips do touchpad); embaixo, as pílulas de volume e canal e os botões
 * redondos. No meio fica o palco, e só ele troca de página, deslizando ou pelos pontos: de um lado as direções com
 * o OK no centro (ou o touchpad), do outro o teclado numérico. O palco é um carrossel de rolagem com encaixe, então
 * o deslize é do próprio navegador, só a janela do palco se mexe e a rolagem horizontal da tela nunca aparece.
 */
@Component({
  selector: 'app-tv-control',
  imports: [RouterLink, KeyButton, TouchpadSurface, DirectionalRing, NumberPad, PageDots, TvIcon],
  templateUrl: './control.page.html',
  styleUrl: './control.page.css',
})
export class ControlPage {
  protected readonly store = inject(TvStore);
  private readonly pager = viewChild.required<ElementRef<HTMLElement>>('pager');

  protected readonly mode = signal<RemoteMode>('buttons');
  protected readonly page = signal(0);

  /** Só os atalhos ativos, na ordem da posição; o número do "Atalho n" é o da posição, que não muda. */
  protected readonly shortcuts = computed(() =>
    (this.store.shortcuts() ?? []).filter((shortcut) => shortcut.enabled),
  );
  protected readonly shortcutsLoaded = computed(() => this.store.shortcuts() !== null);

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

  protected label(shortcut: TvShortcut): string {
    return shortcutLabel(shortcut);
  }

  protected openShortcut(shortcut: TvShortcut): void {
    if (!this.store.canSend()) return;
    void this.store.launch(shortcut);
  }

  protected setMode(mode: RemoteMode): void {
    this.mode.set(mode);
  }

  protected pageLabel(index: number): string {
    const number = index + 1;
    const total = PAGE_COUNT;
    return $localize`:@@tv.pager.page:Página ${number}:number: de ${total}:total:`;
  }

  /** Acompanha o encaixe do carrossel para marcar o ponto da página que está à vista. */
  protected onScroll(): void {
    const element = this.pager().nativeElement;
    if (element.clientWidth === 0) return;
    this.page.set(Math.round(element.scrollLeft / element.clientWidth));
  }

  protected goTo(index: number): void {
    const element = this.pager().nativeElement;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    element.scrollTo({ left: index * element.clientWidth, behavior: reduced ? 'auto' : 'smooth' });
    this.page.set(index);
  }
}
