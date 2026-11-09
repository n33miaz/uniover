import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { PcInput } from '../data/pc-input';
import { PcStore } from '../data/pc-store';
import type { PcMediaAction } from '../data/pc-types';
import { tick } from '../input/haptics';
import { PcFavorites } from '../ui/favorites';
import { PcSlidesPanel } from '../ui/slides-panel';
import { PcTransport } from '../ui/transport';
import { PcVideoPanel } from '../ui/video-panel';
import { PcVolume } from '../ui/volume';

/** Os três modos da tela, na ordem em que aparecem. */
export type MediaMode = 'music' | 'video' | 'slides';
const MODES: readonly MediaMode[] = ['music', 'video', 'slides'];

/**
 * Mídia do PC, com três modos numa linha só: Música (faixa anterior e seguinte, tocar e pausar), Vídeo (saltos de 10
 * segundos, tela cheia, legendas) e Slides (anterior e próximo ocupando a tela, iniciar, ir ao slide, cronômetro). Música e
 * Vídeo dividem o volume (relativo: arrastar, ou os botões, que repetem segurando), o mudo e o parar. Embaixo, nos três, os
 * favoritos que o próprio PC deixa abrir. Os comandos de mídia saem por `sendMedia` e as teclas pela fila de entrada
 * compartilhada: os dois pelo mesmo `PcApi`, então o canal direto e a nuvem valem para tudo.
 */
@Component({
  selector: 'app-pc-media-page',
  imports: [PcFavorites, PcSlidesPanel, PcTransport, PcVideoPanel, PcVolume],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modes" role="tablist" aria-label="Modo" i18n-aria-label="@@pc.media.modes">
      @for (item of modes; track item.id) {
        <button
          type="button"
          role="tab"
          class="mode"
          [id]="'pc-mode-' + item.id"
          [attr.data-mode]="item.id"
          [attr.aria-selected]="mode() === item.id"
          [attr.aria-controls]="mode() === item.id ? 'pc-mode-panel' : null"
          [attr.tabindex]="mode() === item.id ? 0 : -1"
          (click)="select(item.id)"
          (keydown)="onKey($event)"
        >
          {{ item.label }}
        </button>
      }
    </div>

    <div
      id="pc-mode-panel"
      class="panel"
      role="tabpanel"
      [class.grow]="mode() === 'slides'"
      [attr.aria-labelledby]="'pc-mode-' + mode()"
    >
      @switch (mode()) {
        @case ('music') {
          <app-pc-transport
            previousLabel="Faixa anterior"
            i18n-previousLabel="@@pc.media.previous"
            toggleLabel="Tocar ou pausar"
            i18n-toggleLabel="@@pc.media.play-pause"
            nextLabel="Próxima faixa"
            i18n-nextLabel="@@pc.media.next"
            (previous)="press('PREVIOUS')"
            (playPause)="press('PLAY_PAUSE')"
            (next)="press('NEXT')"
          />
        }
        @case ('video') {
          <app-pc-video-panel />
        }
        @case ('slides') {
          <app-pc-slides-panel />
        }
      }

      @if (mode() !== 'slides') {
        <app-pc-volume />
        <div class="extras">
          <button
            type="button"
            class="extra"
            [attr.data-action]="'mute'"
            [disabled]="!store.canSend()"
            (click)="press('MUTE')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path [attr.d]="'M4 10v4h3.5L12 18V6L7.5 10zM16 9.5l5 5M21 9.5l-5 5'" />
            </svg>
            <span i18n="@@pc.media.mute">Mudo</span>
          </button>
          <button
            type="button"
            class="extra"
            [attr.data-action]="'stop'"
            [disabled]="!store.canSend()"
            (click)="press('STOP')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
            </svg>
            <span i18n="@@pc.media.stop">Parar</span>
          </button>
        </div>
      }
    </div>

    <app-pc-favorites />
  `,
  styleUrl: './media.page.css',
})
export class MediaPage {
  protected readonly store = inject(PcStore);
  private readonly input = inject(PcInput);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly modes: readonly { readonly id: MediaMode; readonly label: string }[] = [
    { id: 'music', label: $localize`:@@pc.media.mode.music:Música` },
    { id: 'video', label: $localize`:@@pc.media.mode.video:Vídeo` },
    { id: 'slides', label: $localize`:@@pc.media.mode.slides:Slides` },
  ];
  protected readonly mode = signal<MediaMode>('music');

  protected select(mode: MediaMode): void {
    this.mode.set(mode);
  }

  /** As setas trocam de modo (e levam o foco junto), como numa lista de abas. */
  protected onKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = MODES[(MODES.indexOf(this.mode()) + step + MODES.length) % MODES.length];
    this.mode.set(next);
    queueMicrotask(() =>
      this.host.nativeElement.querySelector<HTMLElement>(`#pc-mode-${next}`)?.focus(),
    );
  }

  protected press(action: PcMediaAction): void {
    tick();
    void this.store.sendMedia(action);
  }
}
