import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { PcStore } from '../data/pc-store';
import type { PcNowPlaying } from '../data/pc-types';

/** De quanto em quanto tempo a tela pergunta o que toca, enquanto está aberta e à vista. */
export const NOW_PLAYING_POLL_MS = 5_000;

/** Depois de uma tecla de mídia, quanto esperar para perguntar de novo (o Windows leva um instante para trocar a faixa). */
export const NOW_PLAYING_AFTER_KEY_MS = 800;

/**
 * O nome do programa que toca, a partir do que o Windows informa: `Spotify.exe` vira "Spotify" e um app da loja
 * (`Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`) vira "ZuneMusic". Vazio quando não há o que mostrar.
 */
export function appLabel(app: string): string {
  const base = app
    .split('!')[0]
    .split('_')[0]
    .replace(/\.exe$/i, '');
  const parts = base.split(/[\\/.]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? '';
}

/**
 * "Tocando agora": o que o Windows do PC diz estar tocando (título, artista e programa), lido do próprio sistema, então vale
 * para qualquer programa que mostre a faixa na tela de bloqueio. Pergunta ao abrir, a cada `NOW_PLAYING_POLL_MS` enquanto
 * `active` e com a página à vista, e logo depois de uma tecla de mídia (`refreshSoon`). Só existe para um PC que declarou
 * `pc.media.state.v1`; sem leitura (PC fora, falha) mostra o último valor ou nada.
 */
@Component({
  selector: 'app-pc-now-playing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.supportsNowPlaying()) {
      <section class="now" aria-labelledby="pc-now-playing-heading" [attr.aria-live]="'polite'">
        <h2 id="pc-now-playing-heading" class="heading">{{ heading() }}</h2>
        @if (playing(); as track) {
          @if (track.title) {
            <p class="title">{{ track.title }}</p>
          }
          @if (track.artist) {
            <p class="artist">{{ track.artist }}</p>
          }
          @if (source(); as name) {
            <p class="app">{{ name }}</p>
          }
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .now {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      color: var(--a-ink);
      min-width: 0;
    }
    .heading {
      margin: 0;
      color: var(--a-ink3);
      font-size: 0.8rem;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .title,
    .artist,
    .app {
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .title {
      font-size: 1.05rem;
      font-weight: 700;
    }
    .artist {
      color: var(--a-ink);
    }
    .app {
      color: var(--a-ink3);
      font-size: 0.85rem;
    }
  `,
})
export class PcNowPlayingPanel {
  protected readonly store = inject(PcStore);
  /** A tela está no modo em que o "Tocando agora" aparece: só então a pergunta se repete. */
  readonly active = input(true);

  protected readonly playing = signal<PcNowPlaying | null>(null);
  protected readonly heading = computed(() => {
    switch (this.playing()?.status) {
      case 'playing':
        return $localize`:@@pc.now-playing.playing:Tocando Agora`;
      case 'paused':
        return $localize`:@@pc.now-playing.paused:Pausado`;
      case 'stopped':
        return $localize`:@@pc.now-playing.stopped:Parado`;
      case 'none':
        return $localize`:@@pc.now-playing.none:Nada Tocando no PC`;
      default:
        return $localize`:@@pc.now-playing.loading:Tocando Agora`;
    }
  });
  protected readonly source = computed(() => appLabel(this.playing()?.app ?? ''));

  private reading = false;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect((onCleanup) => {
      if (!this.active() || !this.store.supportsNowPlaying() || !this.store.canSend()) return;
      void this.read();
      const timer = setInterval(() => void this.read(), NOW_PLAYING_POLL_MS);
      onCleanup(() => clearInterval(timer));
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    });
  }

  /** Pergunta de novo daqui a pouco: a tecla de mídia acabou de trocar ou pausar a faixa. */
  refreshSoon(): void {
    if (!this.store.supportsNowPlaying()) return;
    if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.read();
    }, NOW_PLAYING_AFTER_KEY_MS);
  }

  /** Uma pergunta por vez, e nenhuma com a página escondida (o celular no bolso não fica perguntando). */
  private async read(): Promise<void> {
    if (this.reading || document.visibilityState === 'hidden') return;
    this.reading = true;
    try {
      const now = await this.store.nowPlaying();
      if (now !== null) this.playing.set(now);
    } finally {
      this.reading = false;
    }
  }
}
