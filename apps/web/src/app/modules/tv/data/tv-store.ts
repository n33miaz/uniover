import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { StreamEvent, StreamService } from '../../../core/sse/stream.service';
import { TV_EVENTS_PATH, TvApi } from './tv-api';
import { TV_CONFIG } from './tv-config';
import { TvFailure, describeFailure } from './tv-errors';
import { withOrder } from './tv-order';
import {
  TV_STREAM_EVENTS,
  TvKey,
  TvShortcut,
  TvState,
  TvWatchdog,
  clockText,
  parseShortcuts,
  parseState,
  parseWatchdog,
  shortcutLabel,
} from './tv-types';

/** Chip de estado do cabeçalho. `hibernating` é "controle dormindo": a TV não está desligada, só a sessão dorme. */
export type TvStatus =
  'unconfigured' | 'offline' | 'waking' | 'loading' | 'agent-off' | 'hot' | 'hibernating';

export type TvLink = 'ok' | 'waking' | 'offline';
export type TvStreamStatus = 'connecting' | 'live' | 'reconnecting';

export interface TvNotice {
  readonly kind: 'error' | 'info';
  readonly text: string;
}

/** Limite do texto digitado, o mesmo da API (caracteres Unicode, não unidades UTF-16). */
export const TV_TEXT_MAX = 200;

const CACHE_KEY = 'uniover.tv.last-state';
/**
 * Os ícones dos apps ficam numa chave só deles: cada um pode ter ~44 mil caracteres e o estado é regravado a cada
 * mudança de volume, então dentro do estado eles pesariam a cada toque (e uma lista cheia estouraria a cota do
 * navegador, levando junto o "visto às"). Aqui a gravação só acontece quando a lista muda, e tem teto.
 */
const ICONS_KEY = 'uniover.tv.app-icons';
/** Teto, em caracteres de base64, do que se guarda de ícones: cerca de 1 MB, bem abaixo da cota de 5 MB do navegador. */
export const ICONS_CACHE_MAX_CHARS = 1_000_000;
const STREAM_EVENTS = [
  TV_STREAM_EVENTS.state,
  TV_STREAM_EVENTS.shortcuts,
  TV_STREAM_EVENTS.watchdog,
  // O `StreamService` liga um ouvinte para cada nome pedido: "open" e "error" chegam como eventos e dão o
  // "reconectando" sem o core precisar expor o estado da conexão.
  'open',
  'error',
];

interface CachedTv {
  readonly state: TvState;
  readonly seenAt: number;
  readonly shortcuts: TvShortcut[] | null;
}

/**
 * Texto digitado válido para a API: 0 a 200 caracteres, sem quebra de linha nem outros caracteres de controle. O vazio
 * é válido: significa "apague o que o agente digitou", e é como o campo da TV esvazia quando se apaga o texto.
 */
export function isValidTvText(text: string): boolean {
  if ([...text].length > TV_TEXT_MAX) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f]/.test(text);
}

/**
 * Estado da tela da TV (signals). Um só para as três abas; a tela chama `start` ao nascer (abre o fluxo SSE, busca o
 * estado e os atalhos e, enquanto a página está visível, "aquece" a sessão com a TV a cada poucos minutos) e `stop`
 * ao ser destruída. Nenhum botão do controle altera o estado de forma otimista: quem muda o estado é o que o servidor
 * informa. A única exceção é a ordem dos atalhos (`reorder`): ela só mexe numa lista da tela, não na TV, e volta ao que
 * era se o servidor recusar.
 */
@Injectable({ providedIn: 'root' })
export class TvStore {
  private readonly api = inject(TvApi);
  private readonly stream = inject(StreamService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly config = inject(TV_CONFIG);
  private readonly doc = inject(DOCUMENT);

  private readonly _state = signal<TvState | null>(null);
  private readonly _seenAt = signal<number | null>(null);
  private readonly _shortcuts = signal<TvShortcut[] | null>(null);
  private readonly _watchdog = signal<TvWatchdog | null>(null);
  private readonly _notConfigured = signal(false);
  private readonly _streamStatus = signal<TvStreamStatus>('connecting');
  private readonly _notice = signal<TvNotice | null>(null);
  private readonly _inFlightKeys = signal(0);
  /** O último texto gravado em `ICONS_KEY`, para não regravar o mesmo. */
  private iconsSaved = '';
  /** A última lista que o servidor confirmou, guardada enquanto a ordem nova não é confirmada (volta para ela se for recusada). */
  private reorderBase: TvShortcut[] | null = null;
  /** A ordem mais nova pedida e ainda não enviada: toques em sequência viram um envio só, sempre com a última. */
  private reorderWanted: string[] | null = null;
  /** O envio em andamento; quem pede outra ordem durante ele se junta a ele. */
  private reorderRun: Promise<boolean> | null = null;
  /** A lista que chegou do servidor durante o envio, à espera: aplicada por cima, a tela piscaria de volta à ordem de um passo atrás. */
  private heldShortcuts: TvShortcut[] | null = null;

  readonly state = this._state.asReadonly();
  readonly shortcuts = this._shortcuts.asReadonly();
  readonly watchdog = this._watchdog.asReadonly();
  readonly notConfigured = this._notConfigured.asReadonly();
  readonly streamStatus = this._streamStatus.asReadonly();
  readonly notice = this._notice.asReadonly();
  readonly inFlightKeys = this._inFlightKeys.asReadonly();

  readonly hibernateMinutes = this.config.hibernateMinutes;

  /** Hora (HH:MM) em que esta tela recebeu o último estado; é o "visto às" mostrado sem rede. */
  readonly seenAtText = computed(() => clockText(this._seenAt()));

  readonly link = computed<TvLink>(() => {
    if (!this.connectivity.online() || this.connectivity.serverState() === 'offline')
      return 'offline';
    return this.connectivity.serverState() === 'waking' ? 'waking' : 'ok';
  });

  /** O que o último estado recebido diz (`null` se nunca chegou um); vale também sem rede, como "visto às". */
  readonly lastKnownStatus = computed<TvStatus | null>(() => {
    const state = this._state();
    if (!state) return null;
    if (!state.agentOnline || state.connection === 'disconnected') return 'agent-off';
    return state.connection === 'hibernating' ? 'hibernating' : 'hot';
  });

  readonly status = computed<TvStatus>(() => {
    if (this.link() === 'offline') return 'offline';
    if (this.link() === 'waking') return 'waking';
    if (this._notConfigured()) return 'unconfigured';
    return this.lastKnownStatus() ?? 'loading';
  });

  /** Dá para mandar comando: há rede, há agente configurado e ele não foi dado como desligado. */
  readonly canSend = computed(
    () => this.link() === 'ok' && !this._notConfigured() && this._state()?.agentOnline !== false,
  );

  /** Por que os botões estão desabilitados (sem falsa promessa); `null` quando estão ativos. */
  readonly disabledReason = computed<string | null>(() => {
    if (this.canSend()) return null;
    switch (this.link()) {
      case 'offline': {
        const seen = this.seenAtText();
        return seen
          ? $localize`:@@tv.reason.offline-seen:Sem rede: o controle precisa de internet. Estado visto às ${seen}:time:.`
          : $localize`:@@tv.reason.offline:Sem rede: o controle precisa de internet.`;
      }
      case 'waking':
        return $localize`:@@tv.reason.waking:O servidor está acordando. Os botões voltam em instantes.`;
      default:
        return this._notConfigured()
          ? $localize`:@@tv.reason.not-configured:Nenhum agente foi configurado para controlar a TV.`
          : $localize`:@@tv.reason.agent-off:O agente da TV está desligado, então os botões não funcionam agora.`;
    }
  });

  /** "controle religado às HH:MM" quando o vigia consertou o serviço; `null` sem evento recente. */
  readonly watchdogNote = computed<string | null>(() => {
    const entry = this._watchdog();
    if (!entry) return null;
    const time = clockText(entry.at);
    if (!time) return null;
    if (entry.kind === 'repaired' || entry.kind === 'recovered') {
      return $localize`:@@tv.watchdog.repaired:controle religado às ${time}:time:`;
    }
    if (entry.kind === 'repair_failed') {
      return $localize`:@@tv.watchdog.failed:reparo do controle falhou às ${time}:time:`;
    }
    return null;
  });

  private started = false;
  private streamSub: Subscription | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onVisibility = () => {
    if (this.visible()) {
      void this.wake();
      void this.refresh();
      this.armWake();
    } else {
      this.disarmWake();
    }
  };
  private readonly onOnline = () => {
    void this.refresh();
    void this.wake();
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this._streamStatus.set('connecting');
    this.hydrate();
    this.streamSub = this.stream.open(TV_EVENTS_PATH, STREAM_EVENTS).subscribe((event) => {
      this.onEvent(event);
    });
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.doc.defaultView?.addEventListener('online', this.onOnline);
    void this.refresh();
    void this.wake();
    this.armWake();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.streamSub?.unsubscribe();
    this.streamSub = null;
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.doc.defaultView?.removeEventListener('online', this.onOnline);
    this.disarmWake();
    clearTimeout(this.noticeTimer);
  }

  /** Busca de novo o estado e os atalhos (abertura da tela, volta da rede, volta de aba oculta). */
  async refresh(): Promise<void> {
    if (this.link() === 'offline') return;
    const [state, shortcuts] = await Promise.allSettled([this.api.state(), this.api.shortcuts()]);
    if (state.status === 'fulfilled') this.applyState(state.value);
    if (shortcuts.status === 'fulfilled') this.receiveShortcuts(shortcuts.value);
  }

  /** Pede ao agente que aqueça a sessão com a TV. Só com a tela visível e com rede; falha não vira aviso. */
  async wake(): Promise<void> {
    if (!this.visible() || this.link() !== 'ok') return;
    // Com o agente fora do ar não há o que aquecer (e cada pedido recusado ocuparia a trilha de comandos): a volta
    // dele chega pelo fluxo, e a leitura periódica do estado cobre o fluxo caído.
    if (this._state()?.agentOnline === false) return;
    try {
      await this.api.wake();
      this._notConfigured.set(false);
    } catch (error) {
      this.absorb(describeFailure(error));
    }
  }

  /** Manda uma tecla. Devolve `true` se a TV confirmou; em falha o aviso já foi mostrado e a repetição deve parar. */
  async sendKey(key: TvKey): Promise<boolean> {
    if (!this.canSend()) return false;
    this._inFlightKeys.update((count) => count + 1);
    try {
      await this.api.sendKey(key);
      if (this._notice()?.kind === 'error') this.clearNotice();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this._inFlightKeys.update((count) => count - 1);
    }
  }

  /**
   * Põe `text` no campo que estiver aberto na TV (o agente trata cada envio como "o campo passa a ser este texto";
   * vazio apaga tudo o que ele digitou). Sem aviso flutuante, nem de sucesso nem de falha: a aba Teclado manda a
   * cada mudança do campo e mostra o resultado dentro da própria tela. Devolve `null` se a TV confirmou, ou a falha
   * (que também atualiza o que se sabe do agente, como `agent-offline`).
   */
  async sendText(text: string): Promise<TvFailure | null> {
    if (!this.canSend()) {
      return {
        kind: 'agent-offline',
        message: this.disabledReason() ?? '',
        retryAfterSeconds: null,
      };
    }
    if (!isValidTvText(text)) {
      return {
        kind: 'invalid',
        message: $localize`:@@tv.keyboard.invalid:Escreva até 200 caracteres, sem quebra de linha.`,
        retryAfterSeconds: null,
      };
    }
    try {
      await this.api.sendText(text);
      return null;
    } catch (error) {
      const failure = describeFailure(error);
      this.absorb(failure);
      return failure;
    }
  }

  /**
   * Desliga a TV com um único pedido (sem passkey: decisão do dono). Devolve a falha, se houver, para a folha
   * mostrar dentro dela. Depois disso a tela não promete que a TV volta: o estado vem do servidor.
   */
  async powerOff(): Promise<TvFailure | null> {
    if (!this.canSend()) {
      return {
        kind: 'agent-offline',
        message: this.disabledReason() ?? '',
        retryAfterSeconds: null,
      };
    }
    try {
      await this.api.powerOff();
      this.showNotice(
        'info',
        $localize`:@@tv.power.sent:Pedido de desligar enviado. A TV só volta com o controle original.`,
      );
      return null;
    } catch (error) {
      const failure = describeFailure(error);
      this.absorb(failure);
      return failure;
    }
  }

  /**
   * Abre o app na TV. Vale para qualquer app instalado, esteja ele fixado no controle ou não: `enabled` só decide quem
   * aparece na fileira de atalhos. Um app que saiu da TV não tem o que abrir (a API também o recusa).
   */
  async launch(shortcut: TvShortcut): Promise<boolean> {
    if (!this.canSend() || !shortcut.installed) return false;
    try {
      await this.api.launch(shortcut.id);
      const name = shortcutLabel(shortcut);
      this.showNotice('info', $localize`:@@tv.apps.launched:${name}:name: aberto na TV.`);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async refreshShortcuts(): Promise<boolean> {
    if (!this.canSend()) return false;
    try {
      await this.api.refreshShortcuts();
      // A lista nova chega pelo fluxo; buscar de novo cobre o caso de o fluxo estar reconectando.
      this.receiveShortcuts(await this.api.shortcuts());
      this.showNotice('info', $localize`:@@tv.apps.refreshed:Lista de apps atualizada.`);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Dá um nome próprio ao atalho; texto vazio volta ao nome da TV (ou a "Atalho n"). Não mexe na TV, então vale sem agente. */
  async renameShortcut(id: string, label: string): Promise<boolean> {
    return this.updateShortcut(id, { customLabel: label });
  }

  async setShortcutEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.updateShortcut(id, { enabled });
  }

  /**
   * Muda a ordem dos atalhos (só o dono: a API recusa o convidado). `ids` é a lista COMPLETA, na ordem desejada. A tela
   * muda na hora e o servidor confirma depois; se ele recusar, a lista volta à última ordem que ele confirmou e um aviso
   * diz que não foi salvo. Toques em sequência não disparam um pedido por toque: enquanto um envio está em curso o
   * seguinte espera, e só a ordem mais nova é enviada. Devolve `true` se o servidor aceitou. Não mexe na TV, então vale
   * sem agente.
   */
  async reorder(ids: readonly string[]): Promise<boolean> {
    if (this.link() !== 'ok') {
      this.showNotice('error', this.disabledReason() ?? '');
      return false;
    }
    const current = this._shortcuts();
    const next = current ? withOrder(current, ids) : null;
    if (!current || !next) return false;

    this.reorderBase ??= current;
    this.reorderWanted = [...ids];
    this.applyShortcuts(next);
    this.reorderRun ??= this.runReorder();
    return this.reorderRun;
  }

  clearNotice(): void {
    clearTimeout(this.noticeTimer);
    this._notice.set(null);
  }

  private async updateShortcut(
    id: string,
    change: { customLabel?: string; enabled?: boolean },
  ): Promise<boolean> {
    if (this.link() !== 'ok') {
      this.showNotice('error', this.disabledReason() ?? '');
      return false;
    }
    try {
      const updated = await this.api.updateShortcut(id, change);
      this._shortcuts.update(
        (list) => list?.map((item) => (item.id === id ? updated : item)) ?? list,
      );
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private async runReorder(): Promise<boolean> {
    try {
      while (this.reorderWanted) {
        const ids = this.reorderWanted;
        this.reorderWanted = null;
        this.reorderBase = await this.api.reorderShortcuts(ids);
      }
      // Tudo confirmado: vale a lista que o servidor devolveu (renumerada por ele). Nada se espera entre aqui e o fim,
      // então nenhum pedido novo entra no meio.
      const confirmed = this.reorderBase;
      const held = this.heldShortcuts;
      this.reorderBase = null;
      this.heldShortcuts = null;
      if (confirmed) this.applyShortcuts(confirmed);
      // O que chegou do servidor durante o envio só importa se não é o que acabou de ser confirmado (outra mudança, do
      // agente ou do próprio dono, se cruzou com o envio): nesse caso a lista certa se busca de novo.
      if (confirmed && held && !sameShortcuts(held, confirmed)) void this.resyncShortcuts();
      return true;
    } catch (error) {
      const base = this.reorderBase;
      this.reorderBase = null;
      this.reorderWanted = null;
      this.heldShortcuts = null;
      if (base) this.applyShortcuts(base);
      this.reportReorderFailure(error);
      void this.resyncShortcuts();
      return false;
    } finally {
      this.reorderRun = null;
    }
  }

  /** Falha de rede, de sessão ou de limite diz a causa; qualquer outra diz só o que importa aqui: não foi salvo. */
  private reportReorderFailure(error: unknown): void {
    const failure = describeFailure(error);
    const known =
      failure.kind === 'network' || failure.kind === 'session' || failure.kind === 'rate-limited';
    this.showNotice(
      'error',
      known
        ? failure.message
        : $localize`:@@tv.apps.reorder-failed:Não foi possível salvar a nova ordem. Ela voltou ao que era.`,
    );
  }

  private async resyncShortcuts(): Promise<void> {
    try {
      this.receiveShortcuts(await this.api.shortcuts());
    } catch {
      // sem rede agora: o fluxo ou a próxima busca trazem a lista certa
    }
  }

  /** Lista de atalhos vinda do servidor (fluxo ou busca): durante o envio de uma ordem ela espera a vez. */
  private receiveShortcuts(list: TvShortcut[]): void {
    if (this.reorderRun) {
      this.heldShortcuts = list;
      return;
    }
    this.applyShortcuts(list);
  }

  private onEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'open':
        this._streamStatus.set('live');
        return;
      case 'error':
        this._streamStatus.set('reconnecting');
        return;
      case TV_STREAM_EVENTS.state: {
        const state = parseState(parse(event.data));
        if (state) this.applyState(state);
        this._streamStatus.set('live');
        return;
      }
      case TV_STREAM_EVENTS.shortcuts: {
        const list = parseShortcuts(parse(event.data));
        if (list) this.receiveShortcuts(list);
        return;
      }
      case TV_STREAM_EVENTS.watchdog: {
        const entry = parseWatchdog(parse(event.data));
        if (entry) this._watchdog.set(entry);
        return;
      }
    }
  }

  private applyState(state: TvState): void {
    this._state.set(state);
    this._seenAt.set(Date.now());
    if (state.agentOnline) this._notConfigured.set(false);
    this.persist();
  }

  private applyShortcuts(list: TvShortcut[]): void {
    this._shortcuts.set(list);
    this.persist();
    this.persistIcons(list);
  }

  /** Fatos que uma falha revela sobre o agente (sem aviso): o estado verdadeiro continua vindo do servidor. */
  private absorb(failure: TvFailure): void {
    if (failure.kind === 'not-configured') this._notConfigured.set(true);
    if (failure.kind === 'agent-offline') {
      this._state.update((state) =>
        state ? { ...state, agentOnline: false, connection: 'disconnected', volume: null } : state,
      );
    }
  }

  private fail(error: unknown): TvFailure {
    const failure = describeFailure(error);
    this.absorb(failure);
    this.showNotice('error', failure.message);
    return failure;
  }

  private showNotice(kind: TvNotice['kind'], text: string): void {
    clearTimeout(this.noticeTimer);
    this._notice.set({ kind, text });
    this.noticeTimer = setTimeout(() => this._notice.set(null), this.config.noticeMs);
  }

  private visible(): boolean {
    return this.doc.visibilityState !== 'hidden';
  }

  private armWake(): void {
    this.disarmWake();
    if (!this.started || !this.visible()) return;
    this.wakeTimer = setInterval(() => {
      void this.wake();
      // Rede de segurança: se o fluxo caiu sem aviso, o estado ainda se renova a cada rodada.
      void this.refresh();
    }, this.config.wakeIntervalMs);
  }

  private disarmWake(): void {
    clearInterval(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private hydrate(): void {
    // Só vale como "último estado visto" quando não há rede: com rede, o estado novo chega em instantes e um
    // estado antigo, mesmo por um segundo, contaria uma história velha.
    if (this._state() || this.link() !== 'offline') return;
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as Partial<CachedTv>;
      const state = parseState(cached.state);
      if (!state || typeof cached.seenAt !== 'number') return;
      this._state.set(state);
      this._seenAt.set(cached.seenAt);
      this._shortcuts.set(this.withCachedIcons(parseShortcuts(cached.shortcuts)));
    } catch {
      // armazenamento indisponível ou texto corrompido: começa sem estado conhecido
    }
  }

  private persist(): void {
    const state = this._state();
    const seenAt = this._seenAt();
    if (!state || seenAt === null) return;
    try {
      // Sem os ícones (ver `ICONS_KEY`): o estado cabe sempre, qualquer que seja o tamanho deles.
      const shortcuts = this._shortcuts()?.map((item) => ({ ...item, iconDataUri: null })) ?? null;
      const cached: CachedTv = { state, seenAt, shortcuts };
      this.doc.defaultView?.localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
    } catch {
      // sem armazenamento: o estado só vive nesta tela
    }
  }

  /** Guarda os ícones da lista (os primeiros que couberem no teto); não regrava se nada mudou. */
  private persistIcons(list: TvShortcut[]): void {
    const icons: Record<string, string> = {};
    let used = 0;
    for (const item of list) {
      const uri = item.iconDataUri;
      if (typeof uri !== 'string' || used + uri.length > ICONS_CACHE_MAX_CHARS) continue;
      icons[item.id] = uri;
      used += uri.length;
    }
    // Chaves em ordem fixa: mudar a ordem dos atalhos não deve regravar (até 1 MB) o que não mudou.
    const text = JSON.stringify(
      Object.fromEntries(Object.entries(icons).sort(([a], [b]) => (a < b ? -1 : 1))),
    );
    if (text === this.iconsSaved) return;
    try {
      this.doc.defaultView?.localStorage.setItem(ICONS_KEY, text);
      this.iconsSaved = text;
    } catch {
      // sem armazenamento ou sem espaço: sem ícones ao abrir sem rede (aparece a inicial), o resto segue igual
    }
  }

  /** Devolve à lista guardada os ícones guardados à parte (a tela offline mostra os mesmos azulejos). */
  private withCachedIcons(list: TvShortcut[] | null): TvShortcut[] | null {
    if (!list) return null;
    let icons: Record<string, unknown> = {};
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(ICONS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') icons = parsed as Record<string, unknown>;
    } catch {
      // texto corrompido: segue sem ícones
    }
    return list.map((item) => {
      const icon = icons[item.id];
      return item.iconDataUri || typeof icon !== 'string' ? item : { ...item, iconDataUri: icon };
    });
  }
}

/** As duas listas dizem o mesmo, atalho por atalho e na mesma ordem. */
function sameShortcuts(a: readonly TvShortcut[], b: readonly TvShortcut[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return (
        item.id === other.id &&
        item.position === other.position &&
        item.enabled === other.enabled &&
        item.installed === other.installed &&
        item.customLabel === other.customLabel &&
        item.tvLabel === other.tvLabel &&
        item.iconDataUri === other.iconDataUri
      );
    })
  );
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
