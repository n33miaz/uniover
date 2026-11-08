import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { POINTER_SENSITIVITIES, type PointerSensitivity } from '../input/pc-acceleration';

export interface PcPrefsValue {
  /** Quanto o ponteiro anda por pixel do dedo; o padrão é 1 para 1, sem curva própria (o Windows já acelera). */
  readonly sensitivity: PointerSensitivity;
  /** Rolagem "natural" (como no celular): o conteúdo acompanha o dedo. */
  readonly invertScroll: boolean;
  /** Mostra os botões Esquerdo, Arrastar e Direito embaixo da superfície (para quem não usa os gestos). */
  readonly clickButtons: boolean;
  /** Mantém a tela do aparelho acesa enquanto o touchpad está aberto. */
  readonly keepAwake: boolean;
  /** A dica de primeiro uso (os três gestos) já foi vista: some ao primeiro toque e não volta. */
  readonly hintSeen: boolean;
}

export const PC_PREFS_DEFAULTS: PcPrefsValue = {
  sensitivity: 'normal',
  invertScroll: false,
  clickButtons: false,
  keepAwake: true,
  hintSeen: false,
};

export const PC_PREFS_KEY = 'uniover.pc.prefs.v1';

/** Chave das escolhas de uma conta neste aparelho (cada pessoa tem as suas). */
export function pcPrefsStorageKey(accountId: string): string {
  return `${PC_PREFS_KEY}.${encodeURIComponent(accountId)}`;
}

/**
 * Valida o que veio do armazenamento campo a campo: um valor estragado, ou um campo que a versão guardada ainda não
 * tinha, volta ao padrão sem derrubar o outro.
 */
function parsePrefs(raw: unknown): PcPrefsValue {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const flag = (name: Exclude<keyof PcPrefsValue, 'sensitivity'>): boolean => {
    const found = stored[name];
    return typeof found === 'boolean' ? found : PC_PREFS_DEFAULTS[name];
  };
  const sensitivity = POINTER_SENSITIVITIES.find((item) => item === stored['sensitivity']);
  return {
    sensitivity: sensitivity ?? PC_PREFS_DEFAULTS.sensitivity,
    invertScroll: flag('invertScroll'),
    clickButtons: flag('clickButtons'),
    keepAwake: flag('keepAwake'),
    hintSeen: flag('hintSeen'),
  };
}

/** As escolhas que a pessoa faz de propósito (a dica já vista não conta como escolha). */
const CHOICES = [
  'sensitivity',
  'invertScroll',
  'clickButtons',
  'keepAwake',
] as const satisfies readonly (keyof PcPrefsValue)[];

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
  readonly clickButtons = computed(() => this.value().clickButtons);
  readonly keepAwake = computed(() => this.value().keepAwake);
  readonly hintSeen = computed(() => this.value().hintSeen);
  /** Alguma escolha difere do padrão. */
  readonly customized = computed(() =>
    CHOICES.some((name) => this.value()[name] !== PC_PREFS_DEFAULTS[name]),
  );

  set(patch: Partial<PcPrefsValue>): void {
    const next = parsePrefs({ ...this.value(), ...patch });
    this.value.set(next);
    this.write(next);
  }

  /** Volta as escolhas ao padrão; a dica vista continua vista. */
  reset(): void {
    this.set({ ...PC_PREFS_DEFAULTS, hintSeen: this.value().hintSeen });
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
