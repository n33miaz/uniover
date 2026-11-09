import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PcInput } from '../data/pc-input';
import { PcPrefs } from '../data/pc-prefs';
import { shortcutById } from '../data/pc-shortcuts';
import { PcShortcutCells } from './shortcut-cells';
import { PcTransport } from './transport';

/**
 * O vídeo: voltar e avançar 10 segundos e tocar ou pausar (as teclas J, L e espaço que o YouTube e os players comuns
 * entendem), e embaixo voltar e avançar 5 segundos, tela cheia e legendas. Todas as teclas vêm do catálogo de atalhos. Os
 * players só escutam a tecla com o foco, então na primeira vez há um aviso de uma linha; ele some ao primeiro toque de
 * vídeo e não volta.
 */
@Component({
  selector: 'app-pc-video-panel',
  imports: [PcShortcutCells, PcTransport],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!prefs.videoHintSeen()) {
      <p class="hint" i18n="@@pc.video.hint">O player precisa estar em foco.</p>
    }
    <app-pc-transport
      [kind]="'seek'"
      [disabled]="input.held()"
      previousLabel="Voltar 10 segundos"
      i18n-previousLabel="@@pc.video.back-10"
      toggleLabel="Tocar ou pausar"
      i18n-toggleLabel="@@pc.media.play-pause"
      nextLabel="Avançar 10 segundos"
      i18n-nextLabel="@@pc.video.forward-10"
      (previous)="tap('video-back-10')"
      (playPause)="tap('play-pause')"
      (next)="tap('video-forward-10')"
    />
    <app-pc-shortcut-cells
      [ids]="['video-back-5', 'video-forward-5', 'video-fullscreen', 'video-subtitles']"
      [columns]="2"
      (used)="seen()"
    />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .hint {
      margin: 0;
      color: var(--a-ink2);
      font-size: var(--fs-small);
      text-align: center;
    }
  `,
})
export class PcVideoPanel {
  protected readonly prefs = inject(PcPrefs);
  protected readonly input = inject(PcInput);

  /** Os três botões grandes mandam atalhos do catálogo (J, espaço, L); o aviso some do mesmo jeito que nas células. */
  protected tap(id: 'video-back-10' | 'play-pause' | 'video-forward-10'): void {
    const action = shortcutById(id)?.action;
    if (action?.kind === 'keys' && this.input.plain(action.key, action.modifiers)) this.seen();
  }

  protected seen(): void {
    if (!this.prefs.videoHintSeen()) this.prefs.set({ videoHintSeen: true });
  }
}
