import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { TvStore } from '../data/tv-store';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { KeyButton } from '../input/key-button';
import { TouchpadSurface } from '../input/touchpad-surface';
import { DirectionalRing } from '../ui/directional-ring';
import { NumberPad } from '../ui/number-pad';
import { PageDots } from '../ui/page-dots';
import { TvIcon } from '../ui/tv-icon';

/** Páginas do palco central: direções com o OK, touchpad e números. */
const PAGE_COUNT = 3;

/**
 * Controle principal (a tela única do módulo). Em cima, o chip fixo "Apps" e os atalhos favoritos da TV (chips que
 * abrem o app ao toque); embaixo, as pílulas de volume e canal e os botões redondos. No meio fica o palco, e só ele
 * troca de página, deslizando ou pelos pontos: direções com o OK no centro, touchpad e teclado numérico. O palco é um
 * carrossel de rolagem com encaixe, então o deslize é do próprio navegador, só a janela do palco se mexe e a
 * rolagem horizontal da tela nunca aparece. Apps e Teclado não são telas: esta tela só avisa a página (`openApps`,
 * `openKeyboard`) para abrir o painel flutuante.
 */
@Component({
  selector: 'app-tv-control',
  imports: [KeyButton, TouchpadSurface, DirectionalRing, NumberPad, PageDots, TvIcon],
  templateUrl: './control.page.html',
  styleUrl: './control.page.css',
})
export class ControlPage {
  protected readonly store = inject(TvStore);
  private readonly pager = viewChild.required<ElementRef<HTMLElement>>('pager');

  /** Os dois avisos levam o botão tocado: o painel devolve o foco a ele ao fechar (o Safari não foca botão ao toque). */
  readonly openApps = output<HTMLElement>();
  readonly openKeyboard = output<HTMLElement>();

  protected readonly pageCount = PAGE_COUNT;
  protected readonly page = signal(0);

  /** Só os atalhos ativos, na ordem da posição; o número do "Atalho n" é o da posição, que não muda. */
  protected readonly shortcuts = computed(() =>
    (this.store.shortcuts() ?? []).filter((shortcut) => shortcut.enabled),
  );

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

  protected askApps(event: Event): void {
    this.openApps.emit(event.currentTarget as HTMLElement);
  }

  protected askKeyboard(event: Event): void {
    this.openKeyboard.emit(event.currentTarget as HTMLElement);
  }

  protected openShortcut(shortcut: TvShortcut): void {
    if (!this.store.canSend()) return;
    void this.store.launch(shortcut);
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
