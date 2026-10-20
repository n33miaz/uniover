import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** Acompanha `prefers-reduced-motion: reduce`: quem anima algo olha este sinal e fica parado quando for verdadeiro. */
@Injectable({ providedIn: 'root' })
export class PrefersReducedMotion {
  private readonly media = inject(DOCUMENT).defaultView?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  );

  readonly reduced = signal(this.media?.matches ?? false);

  constructor() {
    const media = this.media;
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => this.reduced.set(event.matches);
    media.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() => media.removeEventListener?.('change', onChange));
  }
}
