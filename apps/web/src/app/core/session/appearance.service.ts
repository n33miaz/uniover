import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, linkedSignal } from '@angular/core';
import { readLegacyOwner } from './account-id';
import { SessionState } from './session-state';

/** `auto` segue o tema do sistema (padrão do app); `light` e `dark` fixam o tema neste aparelho. */
export type ThemePreference = 'auto' | 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'uniover.theme.v1';

/** Escolha visual enquanto ainda não se sabe quem está usando o aparelho. */
export const PRE_SESSION_THEME_PREFERENCE_KEY = 'uniover.theme.pre-session.v1';

/** A escolha visual desta conta, ainda só neste aparelho. */
export function themePreferenceStorageKey(accountId: string): string {
  return `${THEME_PREFERENCE_KEY}.${encodeURIComponent(accountId)}`;
}

const PREFERENCES: readonly ThemePreference[] = ['auto', 'light', 'dark'];

/**
 * Preferência de tema guardada só neste aparelho. Antes da sessão, usa uma chave visual de pré-sessão; depois, uma chave
 * da conta autenticada. Assim uma troca de conta na mesma aba reaplica imediatamente a escolha certa sem levar consigo a
 * aparência da pessoa anterior. No modo automático o atributo continua sendo o do sistema; nos modos fixos esta classe
 * reafirma a escolha quando o sistema muda de tema.
 */
@Injectable({ providedIn: 'root' })
export class AppearanceService {
  private readonly doc = inject(DOCUMENT);
  private readonly session = inject(SessionState);
  private readonly media = this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly storage = this.openStorage();

  readonly preference = linkedSignal({
    // A segunda leitura acontece quando /me define se esta conta é a dona da preferência antiga.
    source: () => ({
      accountId: this.session.accountId(),
      legacyDecided: this.session.legacyDecided(),
    }),
    computation: ({ accountId }) => this.read(accountId),
  });

  constructor() {
    const reapply = () => this.apply(this.preference());
    this.media?.addEventListener('change', reapply);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener('change', reapply));
    effect(() => this.apply(this.preference()));
  }

  /** Aplica a preferência salva; chamado cedo (no guarda) para a primeira tela já sair no tema certo. */
  restore(): void {
    this.apply(this.preference());
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    try {
      this.storage?.setItem(this.storageKey(this.session.accountId()), preference);
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

  private storageKey(accountId: string | null): string {
    return accountId ? themePreferenceStorageKey(accountId) : PRE_SESSION_THEME_PREFERENCE_KEY;
  }

  private read(accountId: string | null): ThemePreference {
    try {
      const saved = this.preferenceFrom(this.storage?.getItem(this.storageKey(accountId)));
      if (saved) return saved;
      const legacy = () => this.preferenceFrom(this.storage?.getItem(THEME_PREFERENCE_KEY));
      // Sem conta, a chave antiga continua sendo a aparência do aparelho: a primeira pintura não troca de tema.
      if (!accountId) return legacy() ?? 'auto';
      const owner = readLegacyOwner();
      if (owner === accountId) {
        const value = legacy();
        if (value) {
          // A cópia vem antes de qualquer descarte: com armazenamento cheio, a escolha antiga segue intacta.
          this.storage?.setItem(themePreferenceStorageKey(accountId), value);
          return value;
        }
      }
      // A conta vem só da dica da última sessão e ainda não se sabe quem adota a escolha antiga: ela vale como aparência
      // do aparelho (sem ser gravada para a conta) para a primeira pintura não piscar. Quando `/me` decidir, a leitura
      // se refaz: a dona a adota, o convidado fica no automático.
      if (owner === null && !this.session.legacyDecided()) return legacy() ?? 'auto';
      return 'auto';
    } catch {
      return 'auto';
    }
  }

  private preferenceFrom(value: string | null | undefined): ThemePreference | null {
    return PREFERENCES.find((item) => item === value) ?? null;
  }
}
