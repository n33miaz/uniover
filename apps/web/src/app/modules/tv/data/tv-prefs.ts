import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, linkedSignal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { isExtraKey, MAIN_EXTRAS_MAX } from './tv-extras';
import { TvSelection } from './tv-selection';
import { TvKey } from './tv-types';
import { TvApi } from './tv-api';

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

/** Documento comum; a vibração continua vinculada à pessoa e ao aparelho. */
export type TvLayoutValue = Omit<TvPrefsValue, 'vibration'>;

export function tvLayoutCacheKey(tvId: string): string {
  return `uniover.tv.layout.v1.${encodeURIComponent(tvId)}`;
}

function tvLayoutLastKey(accountId: string): string {
  return `uniover.tv.layout.last.${encodeURIComponent(accountId)}`;
}

function tvLayoutPendingKey(tvId: string): string {
  return `uniover.tv.layout.pending.${encodeURIComponent(tvId)}`;
}

function layoutOf(value: TvPrefsValue): TvLayoutValue {
  return {
    name: value.name,
    buttonSize: value.buttonSize,
    showMedia: value.showMedia,
    showChannel: value.showChannel,
    startPage: value.startPage,
    padSpeed: value.padSpeed,
    pillLayout: value.pillLayout,
    extraKeys: value.extraKeys,
    dismissedSuggestions: value.dismissedSuggestions,
  };
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

// eslint-disable-next-line no-control-regex
const CONTROL_TEXT = /[\u0000-\u001f\u007f-\u009f]/;

/** Teto da lista de sugestões removidas: o catálogo é curto, e o armazenamento não pode crescer sem limite. */
const DISMISSED_MAX = 20;

function keys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const text = value.filter(
    (item): item is string =>
      typeof item === 'string' && item !== '' && item.length <= 100 && !CONTROL_TEXT.test(item),
  );
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
    name:
      typeof stored['name'] === 'string' && !CONTROL_TEXT.test(stored['name'])
        ? stored['name'].slice(0, TV_NAME_MAX)
        : defaults.name,
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
 * Preferências do controle da TV: o dono define uma base no servidor, com cópia local para abrir sem rede. A convidada
 * guarda ajustes por conta e por TV neste aparelho; a vibração é sempre pessoal. A TV padrão mantém a chave antiga.
 * A chave ainda mais antiga não identificava a conta que a gravou, então fica preservada e inerte:
 * atribuí-la à primeira pessoa que entrar poderia expor escolhas de outra conta.
 * Nunca guarda dado sensível; sem armazenamento (modo privado) a escolha vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class TvPrefs {
  /** Nome mostrado quando o apelido está vazio. */
  readonly defaultName = $localize`:@@tv.header.name:TV`;

  private readonly session = inject(SessionState);
  private readonly selection = inject(TvSelection);
  private readonly api = inject(TvApi);
  private readonly storage = this.openStorage();
  /** A conta e a TV (nula = a padrão) de quem são as escolhas de agora; trocar de TV troca todas elas. */
  private readonly owner = computed(
    () => {
      const accountId = this.session.accountId();
      const selected = this.selection.selected();
      const offline = !selected && this.selection.tvs() === null;
      // Sem a lista: vale a TV escolhida guardada pela seleção; quem nunca escolheu (uma TV só) usa a última vista.
      const stored = offline ? this.selection.tvId() : null;
      const last = offline && !stored ? this.readLast(accountId) : null;
      return {
        accountId,
        // Chave local das escolhas pessoais: nula na TV padrão, que mantém a chave de antes de haver várias.
        tvId: last ? (last.isDefault ? null : last.id) : this.selection.scope(),
        // Id da TV no servidor (dono da base).
        serverId: selected?.id ?? stored ?? last?.id ?? null,
        role: this.session.role(),
      };
    },
    // A lista de TVs é atualizada com objetos novos; só trocar de conta, de TV ou de papel pode reiniciar as escolhas.
    {
      equal: (a, b) =>
        a.accountId === b.accountId &&
        a.tvId === b.tvId &&
        a.serverId === b.serverId &&
        a.role === b.role,
    },
  );
  private readonly personal = linkedSignal<
    { accountId: string | null; tvId: string | null; serverId: string | null; role: string | null },
    Partial<TvPrefsValue>
  >({
    source: () => this.owner(),
    computation: ({ accountId, tvId }) => this.readPersonal(accountId, tvId),
  });
  private readonly base = linkedSignal<
    { accountId: string | null; tvId: string | null; serverId: string | null; role: string | null },
    TvLayoutValue | null
  >({
    source: () => this.owner(),
    computation: ({ serverId }) => this.readBase(serverId),
  });
  private readonly value = computed(() => {
    const { accountId, serverId, role } = this.owner();
    const personal = this.personal();
    const base = this.base();
    if (!serverId || !accountId || !role || (role === 'owner' && !base))
      return parsePrefs(personal);
    return parsePrefs({
      ...TV_PREFS_DEFAULTS,
      ...base,
      ...(role === 'guest' ? personal : { vibration: personal.vibration }),
    });
  });
  private writes: Promise<void> = Promise.resolve();
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Map<string, TvLayoutValue>();

  constructor() {
    effect(() => {
      const selected = this.selection.selected();
      const accountId = this.session.accountId();
      if (selected && accountId) this.writeLast(accountId, selected.id, selected.isDefault);
    });
    effect(() => {
      const { accountId, serverId } = this.owner();
      // Cada lista nova de TVs (abrir o app, voltar a ter rede) é uma nova leitura da base e reenvia a gravação pendente.
      this.selection.tvs();
      if (accountId && serverId) void this.load(accountId, serverId);
    });
  }

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
  readonly customized = computed(() =>
    this.owner().role === 'guest' && this.owner().serverId
      ? Object.keys(this.personal()).length > 0
      : !sameAsDefaults(this.value()),
  );

  set(patch: Partial<TvPrefsValue>): void {
    this.apply(parsePrefs({ ...this.value(), ...patch }), patch);
  }

  reset(): void {
    if (this.owner().role === 'guest' && this.owner().serverId) {
      this.personal.set({});
      this.removePersonal();
    } else {
      this.apply(TV_PREFS_DEFAULTS, TV_PREFS_DEFAULTS);
    }
  }

  private apply(next: TvPrefsValue, patch: Partial<TvPrefsValue>): void {
    const { accountId, tvId, serverId, role } = this.owner();
    if (!serverId || !accountId || !role) {
      this.personal.set(next);
      this.writePersonal(accountId, tvId, next);
      return;
    }
    if (role === 'guest') {
      const sanitizedPatch = Object.fromEntries(
        Object.keys(patch).map((key) => [key, next[key as keyof TvPrefsValue]]),
      ) as Partial<TvPrefsValue>;
      const personal = { ...this.personal(), ...sanitizedPatch };
      this.personal.set(personal);
      this.writePersonal(accountId, tvId, personal);
      return;
    }
    const current = this.value();
    const layout = layoutOf(next);
    const changed = JSON.stringify(layout) !== JSON.stringify(layoutOf(current));
    if (changed) this.revisions.set(serverId, (this.revisions.get(serverId) ?? 0) + 1);
    this.base.set(layout);
    this.writeBase(serverId, layout);
    if (next.vibration !== current.vibration) {
      const personal = { ...this.personal(), vibration: next.vibration };
      this.personal.set(personal);
      this.writePersonal(accountId, tvId, personal);
    }
    if (changed) {
      this.writePending(serverId, layout);
      this.writes = this.writes
        .then(async () => {
          await this.api.saveLayout(serverId, layout);
          this.clearPending(serverId, layout);
        })
        .catch(() => undefined);
    }
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private readPersonal(accountId: string | null, tvId: string | null): Partial<TvPrefsValue> {
    if (!accountId) return {};
    try {
      const raw = this.storage?.getItem(tvPrefsStorageKey(accountId, tvId));
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const value = parsed as Record<string, unknown>;
      const sanitized = parsePrefs(value);
      return Object.fromEntries(
        Object.keys(TV_PREFS_DEFAULTS)
          .filter((key) => Object.hasOwn(value, key))
          .map((key) => [key, sanitized[key as keyof TvPrefsValue]]),
      ) as Partial<TvPrefsValue>;
    } catch {
      return {}; // JSON corrompido: volta ao padrão sem quebrar o controle
    }
  }

  private writePersonal(
    accountId: string | null,
    tvId: string | null,
    value: Partial<TvPrefsValue>,
  ): void {
    if (!accountId) return;
    try {
      this.storage?.setItem(tvPrefsStorageKey(accountId, tvId), JSON.stringify(value));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }

  private removePersonal(): void {
    const { accountId, tvId } = this.owner();
    if (!accountId) return;
    try {
      this.storage?.removeItem(tvPrefsStorageKey(accountId, tvId));
    } catch {
      // Sem armazenamento, a mudança ainda vale nesta sessão.
    }
  }

  private readBase(serverId: string | null): TvLayoutValue | null {
    if (!serverId) return null;
    try {
      const raw = this.storage?.getItem(tvLayoutCacheKey(serverId));
      return raw ? layoutOf(parsePrefs(JSON.parse(raw))) : null;
    } catch {
      return null;
    }
  }

  private readLast(accountId: string | null): { id: string; isDefault: boolean } | null {
    if (!accountId) return null;
    try {
      const raw = this.storage?.getItem(tvLayoutLastKey(accountId));
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object') return null;
      const stored = value as Record<string, unknown>;
      return typeof stored['id'] === 'string' && typeof stored['isDefault'] === 'boolean'
        ? { id: stored['id'], isDefault: stored['isDefault'] }
        : null;
    } catch {
      return null;
    }
  }

  private writeLast(accountId: string, id: string, isDefault: boolean): void {
    try {
      this.storage?.setItem(tvLayoutLastKey(accountId), JSON.stringify({ id, isDefault }));
    } catch {
      // Sem armazenamento, a TV selecionada continua conhecida nesta sessão.
    }
  }

  private writeBase(serverId: string, value: TvLayoutValue): void {
    try {
      this.storage?.setItem(tvLayoutCacheKey(serverId), JSON.stringify(value));
    } catch {
      // A base recebida segue em memória enquanto o armazenamento estiver bloqueado.
    }
  }

  private readPending(serverId: string): TvLayoutValue | null {
    const inMemory = this.pending.get(serverId);
    if (inMemory) return inMemory;
    try {
      const raw = this.storage?.getItem(tvLayoutPendingKey(serverId));
      return raw ? layoutOf(parsePrefs(JSON.parse(raw))) : null;
    } catch {
      return null;
    }
  }

  private writePending(serverId: string, layout: TvLayoutValue): void {
    this.pending.set(serverId, layout);
    try {
      this.storage?.setItem(tvLayoutPendingKey(serverId), JSON.stringify(layout));
    } catch {
      // Sem armazenamento, a gravação pendente ainda pode ser repetida nesta sessão.
    }
  }

  private clearPending(serverId: string, saved: TvLayoutValue): void {
    if (JSON.stringify(this.readPending(serverId)) !== JSON.stringify(saved)) return;
    this.pending.delete(serverId);
    try {
      this.storage?.removeItem(tvLayoutPendingKey(serverId));
    } catch {
      // A resposta do servidor já confirmou a mudança.
    }
  }

  private async load(accountId: string, serverId: string): Promise<void> {
    const revision = this.revisions.get(serverId) ?? 0;
    try {
      const pending = this.owner().role === 'owner' ? this.readPending(serverId) : null;
      if (pending) {
        await this.api.saveLayout(serverId, pending);
        this.clearPending(serverId, pending);
      }
      let layout = await this.api.layout(serverId);
      if (this.owner().accountId !== accountId || this.owner().serverId !== serverId) return;
      if ((this.revisions.get(serverId) ?? 0) !== revision) return;
      if (!layout && this.owner().role === 'owner') {
        // A primeira carga leva as escolhas antigas do dono; POST não substitui uma base criada em outro aparelho.
        const legacy = parsePrefs(this.personal());
        try {
          layout = await this.api.seedLayout(serverId, layoutOf(legacy));
        } catch {
          layout = await this.api.layout(serverId);
        }
      }
      if (
        layout &&
        this.owner().accountId === accountId &&
        this.owner().serverId === serverId &&
        (this.revisions.get(serverId) ?? 0) === revision
      ) {
        const parsed = layoutOf(parsePrefs(layout));
        this.base.set(parsed);
        this.writeBase(serverId, parsed);
      }
    } catch {
      // Sem rede, a última base desta TV continua disponível no aparelho.
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
