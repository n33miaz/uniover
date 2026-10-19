import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { ModuleDefinition, ModuleRegistry, WidgetSize } from './module-registry';

export interface WidgetPref {
  readonly id: string;
  readonly size: WidgetSize;
  readonly enabled: boolean;
}

export const MODULE_PREFS_KEY = 'uniover.home.widgets.v1';

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
 * (`localStorage`); sincronizar na conta depende de um endpoint de preferências que ainda não existe.
 * Nunca guarda dado sensível.
 */
@Injectable({ providedIn: 'root' })
export class ModulePrefs {
  private readonly registry = inject(ModuleRegistry);
  private readonly storage = this.openStorage();
  private readonly stored = signal<readonly WidgetPref[]>(this.read());

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

  private read(): readonly WidgetPref[] {
    try {
      const raw = this.storage?.getItem(MODULE_PREFS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item: unknown) => {
        const pref = item as Partial<WidgetPref> | null;
        const valid =
          typeof pref?.id === 'string' &&
          (pref.size === 'small' || pref.size === 'wide') &&
          typeof pref.enabled === 'boolean';
        return valid ? [{ id: pref.id as string, size: pref.size!, enabled: pref.enabled! }] : [];
      });
    } catch {
      return []; // JSON corrompido: volta ao padrão em vez de quebrar a Início
    }
  }

  private write(): void {
    try {
      this.storage?.setItem(MODULE_PREFS_KEY, JSON.stringify(this.stored()));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }
}
