import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** `auto` segue o tema do sistema (padrão do app); `light` e `dark` fixam o tema neste aparelho. */
export type ThemePreference = 'auto' | 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'uniover.theme.v1';

const PREFERENCES: readonly ThemePreference[] = ['auto', 'light', 'dark'];

/**
 * Preferência de tema do aparelho. Só guarda a escolha visual em `localStorage` (com `try/catch`) e aplica o
 * atributo `data-theme` da raiz, o mesmo que o `ThemeService` mantém. No modo automático o atributo continua
 * sendo o do sistema; nos modos fixos esta classe reafirma a escolha quando o sistema muda de tema.
 */
@Injectable({ providedIn: 'root' })
export class AppearanceService {
  private readonly doc = inject(DOCUMENT);
  private readonly media = this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly storage = this.openStorage();

  readonly preference = signal<ThemePreference>(this.read());

  constructor() {
    const reapply = () => this.apply(this.preference());
    this.media?.addEventListener('change', reapply);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener('change', reapply));
  }

  /** Aplica a preferência salva; chamado cedo (no guarda) para a primeira tela já sair no tema certo. */
  restore(): void {
    this.apply(this.preference());
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    try {
      this.storage?.setItem(THEME_PREFERENCE_KEY, preference);
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
    this.apply(preference);
  }

  private apply(preference: ThemePreference): void {
    const theme = preference === 'auto' ? (this.media?.matches ? 'dark' : 'light') : preference;
    this.doc.documentElement.setAttribute('data-theme', theme);
  }

  private openStorage(): Storage | null {
    try {
      return this.doc.defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(): ThemePreference {
    try {
      const value = this.storage?.getItem(THEME_PREFERENCE_KEY);
      return PREFERENCES.find((item) => item === value) ?? 'auto';
    } catch {
      return 'auto';
    }
  }
}
