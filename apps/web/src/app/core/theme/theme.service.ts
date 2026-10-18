import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

export type ThemeName = 'light' | 'dark';

/** Segue o tema do sistema (decisão do dono: automático) e o expõe em `data-theme` na raiz. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly media = this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');

  readonly theme = signal<ThemeName>(this.media?.matches ? 'dark' : 'light');

  constructor() {
    this.apply(this.theme());
    const onChange = (event: MediaQueryListEvent) => this.set(event.matches ? 'dark' : 'light');
    this.media?.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener('change', onChange));
  }

  private set(name: ThemeName): void {
    this.theme.set(name);
    this.apply(name);
  }

  private apply(name: ThemeName): void {
    this.doc.documentElement.setAttribute('data-theme', name);
  }
}
