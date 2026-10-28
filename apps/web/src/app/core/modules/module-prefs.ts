import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { SessionState } from '../session/session-state';
import { ModuleDefinition, ModuleRegistry, WidgetSize } from './module-registry';

export interface WidgetPref {
  readonly id: string;
  readonly size: WidgetSize;
  readonly enabled: boolean;
}

/**
 * A chave de antes de haver contas: guardava a escolha de quem usou o aparelho por último, sem dizer de quem era. Hoje só
 * serve de prefixo da chave de cada conta (`modulePrefsStorageKey`) e de nome do que se descarta.
 */
export const MODULE_PREFS_KEY = 'uniover.home.widgets.v1';

/** Onde ficam, por conta, os módulos ligados, a ordem e o tamanho dos blocos da Início neste aparelho. */
export function modulePrefsStorageKey(accountId: string): string {
  return `${MODULE_PREFS_KEY}.${encodeURIComponent(accountId)}`;
}

/** Troca o item de lugar com o vizinho (`-1` sobe, `1` desce); devolve a mesma lista se não houver para onde ir. */
export function moveWidget(list: readonly WidgetPref[], id: string, delta: -1 | 1): WidgetPref[] {
  const from = list.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Leva o item para a posição `to` (usado pelo arrastar). */
export function moveWidgetTo(list: readonly WidgetPref[], id: string, to: number): WidgetPref[] {
  const from = list.findIndex((item) => item.id === id);
  if (from < 0 || to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Preferências da Início: módulos ligados/desligados, ordem e tamanho dos blocos. Ficam só neste aparelho
 * (`localStorage`), numa chave própria por conta; sincronizar na conta depende de um endpoint de preferências que ainda
 * não existe. A escolha é relida quando a conta da sessão muda (sair e entrar noutra conta sem recarregar a página), e uma
 * conta sem escolha guardada usa o padrão. Sem conta conhecida vale o padrão e nada é gravado. A chave de antes, sem conta,
 * não dizia de quem era a escolha: é descartada, nunca entregue a quem entrar primeiro.
 * Nunca guarda dado sensível.
 */
@Injectable({ providedIn: 'root' })
export class ModulePrefs {
  private readonly registry = inject(ModuleRegistry);
  private readonly session = inject(SessionState);
  private readonly storage = this.openStorage();
  private readonly stored = linkedSignal<string | null, readonly WidgetPref[]>({
    source: () => this.session.accountId(),
    computation: (accountId) => this.read(accountId),
  });

  /** Todos os módulos, na ordem escolhida; módulos novos do catálogo entram no fim com o padrão. */
  readonly widgets = computed<readonly WidgetPref[]>(() => {
    const known = new Map(this.registry.modules.map((m) => [m.id, m]));
    const kept = this.stored().filter((pref) => known.has(pref.id));
    const seen = new Set(kept.map((pref) => pref.id));
    const added = this.registry.modules
      .filter((module) => !seen.has(module.id))
      .map((module) => this.defaults(module));
    return [...kept, ...added];
  });

  /** Só o que aparece na grade: módulo desligado some. */
  readonly visible = computed(() =>
    this.widgets()
      .filter((pref) => pref.enabled)
      .flatMap((pref) => {
        const definition = this.registry.find(pref.id);
        return definition ? [{ definition, size: pref.size }] : [];
      }),
  );

  apply(next: readonly WidgetPref[]): void {
    this.stored.set(next.map(({ id, size, enabled }) => ({ id, size, enabled })));
    this.write();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.apply(this.widgets().map((pref) => (pref.id === id ? { ...pref, enabled } : pref)));
  }

  private defaults(module: ModuleDefinition): WidgetPref {
    return { id: module.id, size: module.defaultSize, enabled: true };
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(accountId: string | null): readonly WidgetPref[] {
    if (!accountId) return [];
    try {
      // A escolha de antes das contas não diz de quem foi: dá-la a quem entra agora vazaria a de outra pessoa.
      this.storage?.removeItem(MODULE_PREFS_KEY);
    } catch {
      // armazenamento bloqueado: não há o que apagar nem o que vazar
    }
    try {
      const raw = this.storage?.getItem(modulePrefsStorageKey(accountId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item: unknown) => {
        const pref = item as Partial<WidgetPref> | null;
        const valid =
          typeof pref?.id === 'string' &&
          (pref.size === 'small' || pref.size === 'wide') &&
          typeof pref.enabled === 'boolean';
        // A Início não oferece escolha de tamanho e desenha todos os cartões iguais: um `wide` salvo é só o do Treino de
        // quando ele era largo por padrão, e volta a `small` (vira `small` também no disco, na próxima gravação).
        return valid
          ? [{ id: pref.id as string, size: 'small' as const, enabled: pref.enabled! }]
          : [];
      });
    } catch {
      return []; // JSON corrompido: volta ao padrão em vez de quebrar a Início
    }
  }

  private write(): void {
    const accountId = this.session.accountId();
    if (!accountId) return;
    try {
      this.storage?.setItem(modulePrefsStorageKey(accountId), JSON.stringify(this.stored()));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }
}
