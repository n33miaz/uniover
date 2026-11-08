import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { DEFAULT_PINNED, MAX_PINNED, shortcutById, type PcShortcut } from './pc-shortcuts';

export const PC_PINNED_KEY = 'uniover.pc.pinned.v1';

/** Chave dos atalhos fixados de uma conta neste aparelho (cada pessoa tem os seus). */
export function pcPinnedStorageKey(accountId: string): string {
  return `${PC_PINNED_KEY}.${encodeURIComponent(accountId)}`;
}

/**
 * Valida o que veio do armazenamento: só lista de ids que ainda existem no catálogo, sem repetir, até `MAX_PINNED`. Um id
 * que saiu do catálogo (uma versão nova o tirou) some em silêncio. Uma lista vazia é uma escolha válida (a pessoa fixou
 * nada); o que não é lista volta ao padrão.
 */
function parsePinned(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return DEFAULT_PINNED;
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && shortcutById(item) && seen.size < MAX_PINNED) seen.add(item);
  }
  return [...seen];
}

/**
 * Os atalhos fixados no topo da folha de atalhos: a pessoa escolhe quais (até `MAX_PINNED`). Valem só neste aparelho e por
 * conta, como as preferências do mouse; guardam só ids do catálogo, nunca dado sensível. Sem armazenamento (modo
 * privado) a escolha vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class PcPinned {
  private readonly session = inject(SessionState);
  private readonly storage = this.openStorage();
  private readonly value = linkedSignal<string | null, readonly string[]>({
    source: () => this.session.accountId(),
    computation: (accountId) => this.read(accountId),
  });

  /** Os ids fixados, na ordem em que foram fixados. */
  readonly ids = this.value.asReadonly();
  /** Os atalhos fixados. */
  readonly shortcuts = computed<readonly PcShortcut[]>(() =>
    this.value()
      .map((id) => shortcutById(id))
      .filter((shortcut): shortcut is PcShortcut => shortcut !== undefined),
  );
  /** Não cabe mais nenhum. */
  readonly full = computed(() => this.value().length >= MAX_PINNED);

  isPinned(id: string): boolean {
    return this.value().includes(id);
  }

  /** Fixa o atalho ou, se já está fixado, o solta. Devolve `false` quando não coube (a lista está cheia). */
  toggle(id: string): boolean {
    if (!shortcutById(id)) return false;
    const current = this.value();
    if (current.includes(id)) {
      this.save(current.filter((item) => item !== id));
      return true;
    }
    if (current.length >= MAX_PINNED) return false;
    this.save([...current, id]);
    return true;
  }

  /** Volta aos fixados padrão. */
  reset(): void {
    this.save(DEFAULT_PINNED);
  }

  private save(next: readonly string[]): void {
    this.value.set(next);
    const accountId = this.session.accountId();
    if (!accountId) return;
    try {
      this.storage?.setItem(pcPinnedStorageKey(accountId), JSON.stringify(next));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(accountId: string | null): readonly string[] {
    if (!accountId) return DEFAULT_PINNED;
    try {
      const raw = this.storage?.getItem(pcPinnedStorageKey(accountId));
      return raw ? parsePinned(JSON.parse(raw)) : DEFAULT_PINNED;
    } catch {
      return DEFAULT_PINNED; // JSON corrompido: volta ao padrão sem quebrar a folha
    }
  }
}
