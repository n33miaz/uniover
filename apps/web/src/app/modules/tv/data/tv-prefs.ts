import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';

/** Tamanho dos botões de baixo (pílulas e botões redondos); o fator de cada um está em `KEY_SCALE`. */
export type TvButtonSize = 'compact' | 'comfortable' | 'large';
/** Página com que o palco do meio abre; `last` repete a última vista nesta aba. */
export type TvStartPage = 'directions' | 'numbers' | 'touchpad' | 'last';
/** Quanto o dedo precisa andar no touchpad para valer como uma seta. */
export type TvPadSpeed = 'slow' | 'normal' | 'fast';

export const TV_BUTTON_SIZES: readonly TvButtonSize[] = ['compact', 'comfortable', 'large'];
export const TV_START_PAGES: readonly TvStartPage[] = ['directions', 'numbers', 'touchpad', 'last'];
export const TV_PAD_SPEEDS: readonly TvPadSpeed[] = ['slow', 'normal', 'fast'];

/** O "confortável" é 1: os outros dois são relativos a ele (a medida base mora no CSS do controle). */
export const KEY_SCALE: Readonly<Record<TvButtonSize, number>> = {
  compact: 0.9,
  comfortable: 1,
  large: 1.15,
};

export const TV_PREFS_KEY = 'uniover.tv.prefs.v1';
/**
 * O que cabe no cabeçalho: a coluna do nome mede 94 px no 390 (os botões dos lados e o ponto de estado ficam com o
 * resto) e o nome usa até duas linhas. Medido nesse aparelho, 20 letras cabem inteiras; 21 já passam de duas linhas.
 */
export const TV_NAME_MAX = 20;

export interface TvPrefsValue {
  /** Apelido da TV como foi digitado (limitado, sem aparar: o espaço no meio da digitação não pode sumir). */
  readonly name: string;
  readonly buttonSize: TvButtonSize;
  readonly showMedia: boolean;
  readonly showChannel: boolean;
  readonly vibration: boolean;
  readonly startPage: TvStartPage;
  readonly padSpeed: TvPadSpeed;
}

export const TV_PREFS_DEFAULTS: TvPrefsValue = {
  name: '',
  buttonSize: 'comfortable',
  showMedia: true,
  showChannel: true,
  vibration: true,
  // A última vista na aba é o que o controle sempre fez; quem quer outra página fixa escolhe.
  startPage: 'last',
  padSpeed: 'normal',
};

/**
 * Espelho da escolha de vibração para quem não tem injeção (`vibrate()` é chamada de vários lugares, e uma chamada
 * esquecida não pode ignorar a preferência). Quem manda é o `TvPrefs`, que o atualiza a cada mudança.
 */
let vibrationOn = TV_PREFS_DEFAULTS.vibration;

export function vibrationEnabled(): boolean {
  return vibrationOn;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Valida o que veio do armazenamento campo a campo: um valor estragado volta ao padrão sem derrubar os outros. */
function parsePrefs(raw: unknown): TvPrefsValue {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const defaults = TV_PREFS_DEFAULTS;
  return {
    name: typeof stored['name'] === 'string' ? stored['name'].slice(0, TV_NAME_MAX) : defaults.name,
    buttonSize: oneOf(stored['buttonSize'], TV_BUTTON_SIZES, defaults.buttonSize),
    showMedia: flag(stored['showMedia'], defaults.showMedia),
    showChannel: flag(stored['showChannel'], defaults.showChannel),
    vibration: flag(stored['vibration'], defaults.vibration),
    startPage: oneOf(stored['startPage'], TV_START_PAGES, defaults.startPage),
    padSpeed: oneOf(stored['padSpeed'], TV_PAD_SPEEDS, defaults.padSpeed),
  };
}

/**
 * Preferências do controle da TV: apelido, tamanho dos botões, que grupos de teclas aparecem, vibração, página
 * inicial do palco e sensibilidade do touchpad. Ficam só neste aparelho (`localStorage`, como as da Início): o
 * convidado tem as dele, e sincronizar na conta depende de um endpoint de preferências que ainda não existe.
 * Nunca guarda dado sensível; sem armazenamento (modo privado) a escolha vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class TvPrefs {
  /** Nome mostrado quando o apelido está vazio. */
  readonly defaultName = $localize`:@@tv.header.name:TV`;

  private readonly storage = this.openStorage();
  private readonly value = signal<TvPrefsValue>(this.read());

  /** O apelido aparado; vazio quando não há. */
  readonly name = computed(() => this.value().name.trim());
  /** O que o cabeçalho mostra: o apelido ou o nome padrão. */
  readonly title = computed(() => this.name() || this.defaultName);
  readonly buttonSize = computed(() => this.value().buttonSize);
  readonly keyScale = computed(() => KEY_SCALE[this.buttonSize()]);
  readonly showMedia = computed(() => this.value().showMedia);
  readonly showChannel = computed(() => this.value().showChannel);
  readonly vibration = computed(() => this.value().vibration);
  readonly startPage = computed(() => this.value().startPage);
  readonly padSpeed = computed(() => this.value().padSpeed);
  /** Alguma escolha difere do padrão (liga o "Restaurar padrão"). */
  readonly customized = computed(() => !sameAsDefaults(this.value()));

  constructor() {
    vibrationOn = this.value().vibration;
  }

  set(patch: Partial<TvPrefsValue>): void {
    this.apply(parsePrefs({ ...this.value(), ...patch }));
  }

  reset(): void {
    this.apply(TV_PREFS_DEFAULTS);
  }

  private apply(next: TvPrefsValue): void {
    this.value.set(next);
    vibrationOn = next.vibration;
    this.write(next);
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(): TvPrefsValue {
    try {
      const raw = this.storage?.getItem(TV_PREFS_KEY);
      return parsePrefs(raw ? JSON.parse(raw) : null);
    } catch {
      return TV_PREFS_DEFAULTS; // JSON corrompido: volta ao padrão em vez de quebrar o controle
    }
  }

  private write(value: TvPrefsValue): void {
    try {
      this.storage?.setItem(TV_PREFS_KEY, JSON.stringify(value));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }
}

function sameAsDefaults(value: TvPrefsValue): boolean {
  const defaults = TV_PREFS_DEFAULTS;
  return (
    value.name.trim() === defaults.name &&
    value.buttonSize === defaults.buttonSize &&
    value.showMedia === defaults.showMedia &&
    value.showChannel === defaults.showChannel &&
    value.vibration === defaults.vibration &&
    value.startPage === defaults.startPage &&
    value.padSpeed === defaults.padSpeed
  );
}
