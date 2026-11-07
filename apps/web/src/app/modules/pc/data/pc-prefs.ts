import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { POINTER_SENSITIVITIES, type PointerSensitivity } from '../input/pc-acceleration';

export interface PcPrefsValue {
  /** Quanto o ponteiro anda por pixel do dedo; o padrão é 1 para 1, sem curva própria (o Windows já acelera). */
  readonly sensitivity: PointerSensitivity;
  /** Rolagem "natural" (como no celular): o conteúdo acompanha o dedo. */
  readonly invertScroll: boolean;
}

export const PC_PREFS_DEFAULTS: PcPrefsValue = { sensitivity: 'normal', invertScroll: false };

export const PC_PREFS_KEY = 'uniover.pc.prefs.v1';

/** Chave das escolhas de uma conta neste aparelho (cada pessoa tem as suas). */
export function pcPrefsStorageKey(accountId: string): string {
  return `${PC_PREFS_KEY}.${encodeURIComponent(accountId)}`;
}

/** Valida o que veio do armazenamento campo a campo: um valor estragado volta ao padrão sem derrubar o outro. */
function parsePrefs(raw: unknown): PcPrefsValue {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sensitivity = POINTER_SENSITIVITIES.find((item) => item === stored['sensitivity']);
  return {
    sensitivity: sensitivity ?? PC_PREFS_DEFAULTS.sensitivity,
    invertScroll:
      typeof stored['invertScroll'] === 'boolean'
        ? stored['invertScroll']
        : PC_PREFS_DEFAULTS.invertScroll,
  };
}

/**
 * Preferências do touchpad do PC. Valem só neste aparelho (a mesma pessoa pode querer outro ritmo no iPhone e no
 * tablet) e por conta, como a vibração do controle da TV. Nunca guarda dado sensível; sem armazenamento (modo privado) a
 * escolha vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class PcPrefs {
  private readonly session = inject(SessionState);
  private readonly storage = this.openStorage();
  private readonly value = linkedSignal<string | null, PcPrefsValue>({
    source: () => this.session.accountId(),
    computation: (accountId) => this.read(accountId),
  });

  readonly sensitivity = computed(() => this.value().sensitivity);
  readonly invertScroll = computed(() => this.value().invertScroll);
  /** Alguma escolha difere do padrão. */
  readonly customized = computed(
    () =>
      this.value().sensitivity !== PC_PREFS_DEFAULTS.sensitivity ||
      this.value().invertScroll !== PC_PREFS_DEFAULTS.invertScroll,
  );

  set(patch: Partial<PcPrefsValue>): void {
    const next = parsePrefs({ ...this.value(), ...patch });
    this.value.set(next);
    this.write(next);
  }

  reset(): void {
    this.set(PC_PREFS_DEFAULTS);
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(accountId: string | null): PcPrefsValue {
    if (!accountId) return PC_PREFS_DEFAULTS;
    try {
      const raw = this.storage?.getItem(pcPrefsStorageKey(accountId));
      return raw ? parsePrefs(JSON.parse(raw)) : PC_PREFS_DEFAULTS;
    } catch {
      return PC_PREFS_DEFAULTS; // JSON corrompido: volta ao padrão sem quebrar o touchpad
    }
  }

  private write(value: PcPrefsValue): void {
    const accountId = this.session.accountId();
    if (!accountId) return;
    try {
      this.storage?.setItem(pcPrefsStorageKey(accountId), JSON.stringify(value));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }
}
