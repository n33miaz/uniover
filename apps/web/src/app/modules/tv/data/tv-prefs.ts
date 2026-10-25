import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { isExtraKey, MAIN_EXTRAS_MAX } from './tv-extras';
import { TvSelection } from './tv-selection';
import { TvKey } from './tv-types';

/** Tamanho dos botões de baixo (pílulas e botões redondos); o fator de cada um está em `KEY_SCALE`. */
export type TvButtonSize = 'compact' | 'comfortable' | 'large';
/** Página com que o palco do meio abre; `last` repete a última vista nesta aba. */
export type TvStartPage = 'directions' | 'numbers' | 'touchpad' | 'last';
/** Quanto o dedo precisa andar no touchpad para valer como uma seta. */
export type TvPadSpeed = 'slow' | 'normal' | 'fast';
/**
 * Onde ficam as pílulas de volume e de canal: `sides` põe uma de cada lado dos botões redondos (em pé, o padrão de
 * sempre); `row` junta as duas numa fileira deitada acima dos botões redondos, que então crescem.
 */
export type TvPillLayout = 'sides' | 'row';

export const TV_BUTTON_SIZES: readonly TvButtonSize[] = ['compact', 'comfortable', 'large'];
export const TV_START_PAGES: readonly TvStartPage[] = ['directions', 'numbers', 'touchpad', 'last'];
export const TV_PAD_SPEEDS: readonly TvPadSpeed[] = ['slow', 'normal', 'fast'];
export const TV_PILL_LAYOUTS: readonly TvPillLayout[] = ['sides', 'row'];

/** O "confortável" é 1: os outros dois são relativos a ele (a medida base mora no CSS do controle). */
export const KEY_SCALE: Readonly<Record<TvButtonSize, number>> = {
  compact: 0.9,
  comfortable: 1,
  large: 1.15,
};

export const TV_PREFS_KEY = 'uniover.tv.prefs.v2';

/**
 * Chave das escolhas de uma conta numa TV. A TV padrão (`tvId` nulo) segue na chave de sempre, para nada do que já estava
 * guardado se perder; cada outra TV tem a sua, dentro da conta (as preferências são por conta **e** por TV).
 */
export function tvPrefsStorageKey(accountId: string, tvId: string | null = null): string {
  const base = `${TV_PREFS_KEY}.${encodeURIComponent(accountId)}`;
  return tvId ? `${base}.tv.${encodeURIComponent(tvId)}` : base;
}
/**
 * O que cabe no cabeçalho: o nome usa até duas linhas na coluna do meio, que no 390 é a tela menos duas colunas
 * iguais de 94 px (os dois botões da esquerda; à direita o desligar e o ponto de estado cabem na mesma largura). O
 * limite de 20 letras vem de quando a coluna era mais estreita (medido então: 20 cabiam inteiras, 21 passavam de duas
 * linhas); com a coluna de agora sobra espaço, e o limite foi mantido para não mudar o que a pessoa pode digitar.
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
  /** Ausente nas escolhas guardadas antes de existir: lê-se como `sides`, a disposição que sempre foi. */
  readonly pillLayout: TvPillLayout;
  /**
   * Os botões extras que a pessoa escolheu para a tela principal, na ordem. `null` (o padrão) deixa os mais importantes
   * da TV preencherem os espaços vazios; ausente nas escolhas guardadas antes de existir.
   */
  readonly extraKeys: readonly TvKey[] | null;
  /** Sugestões de atalho que a pessoa removeu (as chaves do catálogo); ausente nas escolhas de antes, lê-se como vazio. */
  readonly dismissedSuggestions: readonly string[];
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
  pillLayout: 'sides',
  extraKeys: null,
  dismissedSuggestions: [],
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Teto da lista de sugestões removidas: o catálogo é curto, e o armazenamento não pode crescer sem limite. */
const DISMISSED_MAX = 20;

function keys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const text = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return [...new Set(text)].slice(0, DISMISSED_MAX);
}

/** A lista de botões extras guardada: só os que o app conhece, sem repetir e até o que cabe na tela principal. */
function extras(value: unknown): readonly TvKey[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter(isExtraKey))].slice(0, MAIN_EXTRAS_MAX);
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
    pillLayout: oneOf(stored['pillLayout'], TV_PILL_LAYOUTS, defaults.pillLayout),
    extraKeys: extras(stored['extraKeys']),
    dismissedSuggestions: keys(stored['dismissedSuggestions']),
  };
}

/**
 * Preferências do controle da TV: apelido, tamanho dos botões, disposição das pílulas de volume e canal, que grupos
 * de teclas aparecem, vibração, página inicial do palco, sensibilidade do touchpad e as sugestões de atalho removidas. Ficam neste aparelho, em
 * uma chave própria por conta **e por TV** (a TV padrão usa a chave de antes de haver várias, e nada se perde). A chave antiga não identificava a conta que a gravou, então fica preservada e inerte:
 * atribuí-la à primeira pessoa que entrar poderia expor escolhas de outra conta.
 * Nunca guarda dado sensível; sem armazenamento (modo privado) a escolha vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class TvPrefs {
  /** Nome mostrado quando o apelido está vazio. */
  readonly defaultName = $localize`:@@tv.header.name:TV`;

  private readonly session = inject(SessionState);
  private readonly selection = inject(TvSelection);
  private readonly storage = this.openStorage();
  /** A conta e a TV (nula = a padrão) de quem são as escolhas de agora; trocar de TV troca todas elas. */
  private readonly owner = computed(() => ({
    accountId: this.session.accountId(),
    tvId: this.selection.scope(),
  }));
  private readonly value = linkedSignal<
    { accountId: string | null; tvId: string | null },
    TvPrefsValue
  >({
    source: () => this.owner(),
    computation: ({ accountId, tvId }) => this.read(accountId, tvId),
  });

  /** O apelido aparado; vazio quando não há. */
  readonly name = computed(() => this.value().name.trim());
  /**
   * O que o cabeçalho mostra: o apelido ou, com várias TVs, o nome que o administrador deu à TV (é ele que diz qual é qual)
   * e, por último, o nome padrão. Com uma TV só o título é o de sempre.
   */
  readonly title = computed(
    () =>
      this.name() ||
      (this.selection.multiple() ? (this.selection.selected()?.name.trim() ?? '') : '') ||
      this.defaultName,
  );
  readonly buttonSize = computed(() => this.value().buttonSize);
  readonly keyScale = computed(() => KEY_SCALE[this.buttonSize()]);
  readonly showMedia = computed(() => this.value().showMedia);
  readonly showChannel = computed(() => this.value().showChannel);
  readonly vibration = computed(() => this.value().vibration);
  readonly startPage = computed(() => this.value().startPage);
  readonly padSpeed = computed(() => this.value().padSpeed);
  readonly pillLayout = computed(() => this.value().pillLayout);
  readonly extraKeys = computed(() => this.value().extraKeys);
  readonly dismissedSuggestions = computed(() => this.value().dismissedSuggestions);
  /** Alguma escolha difere do padrão (liga o "Restaurar padrão"). */
  readonly customized = computed(() => !sameAsDefaults(this.value()));

  set(patch: Partial<TvPrefsValue>): void {
    this.apply(parsePrefs({ ...this.value(), ...patch }));
  }

  reset(): void {
    this.apply(TV_PREFS_DEFAULTS);
  }

  private apply(next: TvPrefsValue): void {
    this.value.set(next);
    const { accountId, tvId } = this.owner();
    this.write(accountId, tvId, next);
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(accountId: string | null, tvId: string | null): TvPrefsValue {
    if (!accountId) return TV_PREFS_DEFAULTS;
    try {
      const raw = this.storage?.getItem(tvPrefsStorageKey(accountId, tvId));
      return parsePrefs(raw ? JSON.parse(raw) : null);
    } catch {
      return TV_PREFS_DEFAULTS; // JSON corrompido: volta ao padrão em vez de quebrar o controle
    }
  }

  private write(accountId: string | null, tvId: string | null, value: TvPrefsValue): void {
    if (!accountId) return;
    try {
      this.storage?.setItem(tvPrefsStorageKey(accountId, tvId), JSON.stringify(value));
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
    value.padSpeed === defaults.padSpeed &&
    value.pillLayout === defaults.pillLayout &&
    value.extraKeys === null &&
    value.dismissedSuggestions.length === 0
  );
}
