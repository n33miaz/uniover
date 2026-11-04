import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../../../core/session/session-state';
import { TvApi } from '../../data/tv-api';
import { TvSelection } from '../../data/tv-selection';
import type { TvShortcut } from '../../data/tv-types';
import {
  LivreAppRow,
  appRows,
  buildConfig,
  groupApps,
  moveApp,
  normalizeApps,
  previewApps,
  sameConfig,
  setAppChosen,
} from './livre-config';
import { describeLivreFailure } from './livre-errors';
import { TvLivreApi } from './livre-api';
import { LIVRE_PHOTO_REDUCER } from './photo-fit';
import {
  DEFAULT_LIVRE_CONFIG,
  LivreConfig,
  SLEEP_MAX_MINUTES,
  TvLivreView,
  normalizeColor,
} from './livre-types';

/** O que está em andamento: um pedido por vez, porque cada um mexe numa TV real e os longos levam dezenas de segundos. */
export type LivreAction =
  'refresh' | 'apply' | 'install' | 'set-home' | 'restore' | 'sleep' | 'photo';

export interface LivreNotice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

/** Por que a tela não deixa mexer na TV: `unsupported` (a TV não é compatível) ou `offline` (o agente não está ao alcance). */
export type LivreBlock = 'unsupported' | 'offline';

/** Falha que nasce na própria tela (a foto não pôde ser lida), com a frase já pronta. */
class LocalFailure extends Error {}

/** O pedido era de uma conta ou TV que já não está na tela: o que ele trouxer (sucesso ou erro) não vale mais. */
class StaleRequest extends Error {}

/** A foto como texto `data:` (a política de segurança do app só aceita `img-src 'self' data:`, nunca `blob:`). */
function toDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Estado do TV Livre (signals), um para as quatro telas. Guarda o que a API disse da TV atual (`view`), um rascunho da
 * configuração que as telas Home da TV, Fundo e Dormir editam juntas (nada vai à TV até "Aplicar na TV") e a miniatura da foto.
 * A tela chama `start` ao abrir e `stop` ao sair; nada é buscado fora disso.
 *
 * Um pedido por vez: enquanto `busy` não é nulo, os outros são ignorados e os botões ficam desligados. Nada é feito de forma
 * otimista: o que vale é o estado que o servidor devolve. Trocar de conta ou de TV apaga tudo e busca de novo, e
 * qualquer resposta que ainda chegue da anterior é descartada (`epoch`).
 */
@Injectable({ providedIn: 'root' })
export class TvLivreStore {
  private readonly api = inject(TvLivreApi);
  private readonly tvApi = inject(TvApi);
  private readonly session = inject(SessionState);
  private readonly selection = inject(TvSelection);
  private readonly reducer = inject(LIVRE_PHOTO_REDUCER);

  private epoch = 0;
  private started = false;

  private readonly _view = signal<TvLivreView | null>(null);
  private readonly _shortcuts = signal<readonly TvShortcut[]>([]);
  private readonly _draft = signal<LivreConfig | null>(null);
  private readonly _photoUrl = signal<string | null>(null);
  private readonly _loading = signal(false);
  private readonly _loadFailure = signal<string | null>(null);
  private readonly _busy = signal<LivreAction | null>(null);
  private readonly _notice = signal<LivreNotice | null>(null);

  readonly view = this._view.asReadonly();
  readonly draft = this._draft.asReadonly();
  /** A miniatura da foto como `data:`; `null` sem foto (ou enquanto ela não chegou). */
  readonly photoUrl = this._photoUrl.asReadonly();
  /** A primeira leitura em andamento (sem estado ainda para mostrar). */
  readonly loading = this._loading.asReadonly();
  /** A frase da primeira leitura que falhou; some quando uma leitura dá certo. */
  readonly loadFailure = this._loadFailure.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly notice = this._notice.asReadonly();

  /** O TV Livre pode mexer na TV agora: o agente está ao alcance e a TV é compatível. */
  readonly canUse = computed(() => {
    const view = this._view();
    return view !== null && view.available && view.supported !== false;
  });

  /** O motivo de não poder mexer na TV, ou `null` se pode (ou se ainda não se sabe nada). */
  readonly block = computed<LivreBlock | null>(() => {
    const view = this._view();
    if (view === null) return null;
    if (view.supported === false) return 'unsupported';
    return view.available ? null : 'offline';
  });

  /** "Voltar ao Original" fica sempre à vista quando a TV é compatível, mesmo com o agente fora do ar (então desligado). */
  readonly restoreVisible = computed(() => {
    const view = this._view();
    return view !== null && view.supported !== false;
  });

  private readonly rows = computed<LivreAppRow[]>(() => {
    const view = this._view();
    const draft = this._draft();
    return view && draft ? appRows(view.apps, this._shortcuts(), draft) : [];
  });

  /** Os apps para escolher e ordenar: escolhidos (na ordem da Home), os outros e os de fábrica. */
  readonly groups = computed(() => {
    return groupApps(this.rows(), this._draft() ?? DEFAULT_LIVRE_CONFIG);
  });

  /** O que a Home mostrará na TV, na ordem do launcher; é o que a pré-visualização desenha. */
  readonly preview = computed(() => {
    const draft = this._draft();
    return draft ? previewApps(draft, this.rows()) : [];
  });

  /** Há mudança que ainda não foi enviada à TV (o rascunho difere da configuração guardada). */
  readonly dirty = computed(() => {
    const view = this._view();
    const draft = this._draft();
    if (!view || !draft) return false;
    const context = { hasPhoto: view.hasPhoto, apps: view.apps };
    return !sameConfig(buildConfig(draft, context), buildConfig(view.config, context));
  });

  constructor() {
    // Outra conta ou outra TV: nada do que se sabia vale, e quem está com a tela aberta recebe o estado da nova. A primeira
    // passada só anota onde se está (a tela que acabou de abrir já mandou ler), senão a primeira leitura seria descartada.
    let current: string | null = null;
    effect(() => {
      const key = `${this.session.accountId()}|${this.selection.tvId()}`;
      untracked(() => {
        const changed = current !== null && key !== current;
        current = key;
        if (!changed) return;
        this.reset();
        if (this.started) void this.load();
      });
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // O aviso é do pedido de antes de sair da tela; o estado e o rascunho ficam (a tela abre já com eles e renova por baixo).
    this._notice.set(null);
    void this.load();
  }

  stop(): void {
    this.started = false;
  }

  /** Lê o estado e os atalhos da TV (para nome e ícone dos apps). Sem estado ainda, mostra a espera; com ele, atualiza por baixo. */
  async load(): Promise<void> {
    const epoch = this.epoch;
    if (this._view() === null) this._loading.set(true);
    this._loadFailure.set(null);
    try {
      const [view, shortcuts] = await Promise.all([
        this.api.get(),
        // Sem os atalhos os apps aparecem do mesmo jeito, só com o nome tirado do pacote e a inicial no lugar do ícone.
        this.tvApi.shortcuts().catch(() => null),
      ]);
      if (epoch !== this.epoch) return;
      if (shortcuts) this._shortcuts.set(shortcuts);
      this.adopt(view, epoch);
    } catch (error) {
      if (epoch !== this.epoch) return;
      const text = describeLivreFailure(error).message;
      if (this._view() === null) this._loadFailure.set(text);
      else this._notice.set({ kind: 'error', text });
    } finally {
      if (epoch === this.epoch) this._loading.set(false);
    }
  }

  /** Pede ao agente o estado de agora (instalado, versão, é a tela inicial?). */
  refresh(): Promise<boolean> {
    return this.run('refresh', async (epoch) => {
      this.adopt(await this.live(epoch, this.api.refresh()), epoch);
      return $localize`:@@tv-livre.notice.refreshed:Estado atualizado.`;
    });
  }

  /**
   * "Aplicar na TV": guarda a configuração montada na tela e a manda à TV. Se guardar dá certo e aplicar não, o aviso diz que
   * ficou guardada, para a pessoa saber que não precisa refazer nada.
   */
  apply(): Promise<boolean> {
    const draft = this._draft();
    const view = this._view();
    if (!draft || !view) return Promise.resolve(false);
    return this.run('apply', async (epoch) => {
      const saved = await this.live(
        epoch,
        this.api.saveConfig(buildConfig(draft, { hasPhoto: view.hasPhoto, apps: view.apps })),
      );
      this.adopt(saved, epoch, true);
      try {
        this.adopt(await this.live(epoch, this.api.apply()), epoch);
      } catch (error) {
        if (error instanceof StaleRequest) throw error;
        const reason = describeLivreFailure(error).message;
        throw new LocalFailure(
          $localize`:@@tv-livre.notice.saved-not-applied:Salvo, mas a TV não aplicou. ${reason}:reason:`,
        );
      }
      return $localize`:@@tv-livre.notice.applied:Aplicado na TV.`;
    });
  }

  install(): Promise<boolean> {
    return this.run('install', async (epoch) => {
      this.adopt(await this.live(epoch, this.api.install()), epoch);
      return $localize`:@@tv-livre.notice.installed:TV Livre instalado.`;
    });
  }

  /** Define o TV Livre como a tela inicial; com `disableFactory` desativa também o launcher de fábrica. */
  setHome(disableFactory: boolean): Promise<boolean> {
    return this.run('set-home', async (epoch) => {
      this.adopt(await this.live(epoch, this.api.setHome(disableFactory)), epoch);
      return $localize`:@@tv-livre.notice.home-set:TV Livre é a tela inicial.`;
    });
  }

  /** "Voltar ao Original": devolve a tela inicial de fábrica e desinstala o TV Livre. */
  restore(): Promise<boolean> {
    return this.run('restore', async (epoch) => {
      this.adopt(await this.live(epoch, this.api.restore(true)), epoch);
      return $localize`:@@tv-livre.notice.restored:A TV voltou ao original.`;
    });
  }

  sleep(): Promise<boolean> {
    return this.run('sleep', async (epoch) => {
      await this.live(epoch, this.api.sleep());
      return $localize`:@@tv-livre.notice.sleeping:Modo Dormir enviado à TV.`;
    });
  }

  /** Reduz a foto no navegador e a envia; o fundo passa a ser a foto. */
  choosePhoto(file: Blob): Promise<boolean> {
    return this.run('photo', async (epoch) => {
      const fit = await this.live(epoch, this.reducer(file));
      if (fit.status === 'invalid') {
        throw new LocalFailure($localize`:@@tv-livre.photo.invalid:Não deu para ler esta foto.`);
      }
      if (fit.status === 'too-big') {
        throw new LocalFailure(
          $localize`:@@tv-livre.photo.too-big:A foto continua grande demais mesmo reduzida.`,
        );
      }
      await this.live(epoch, this.api.putPhoto(fit.blob));
      const url = await this.live(epoch, toDataUrl(fit.blob));
      this._photoUrl.set(url);
      this._view.update((view) => (view ? { ...view, hasPhoto: true } : view));
      this.edit((draft) => ({ ...draft, wallpaper: { ...draft.wallpaper, type: 'photo' } }));
      return $localize`:@@tv-livre.photo.saved:Foto salva.`;
    });
  }

  removePhoto(): Promise<boolean> {
    return this.run('photo', async (epoch) => {
      await this.live(epoch, this.api.deletePhoto());
      this._photoUrl.set(null);
      this._view.update((view) => (view ? { ...view, hasPhoto: false } : view));
      // Sem foto, o fundo volta ao degradê (o launcher faria o mesmo, e a API não aplica foto que não existe).
      this.edit((draft) =>
        draft.wallpaper.type === 'photo'
          ? { ...draft, wallpaper: { ...draft.wallpaper, type: 'gradient' } }
          : draft,
      );
      return $localize`:@@tv-livre.photo.removed:Foto removida.`;
    });
  }

  setWallpaperType(type: 'gradient' | 'photo'): void {
    this.edit((draft) => ({ ...draft, wallpaper: { ...draft.wallpaper, type } }));
  }

  /** Troca uma das duas cores do degradê; um valor que não é `#rrggbb` é ignorado. */
  setColor(index: 0 | 1, value: string): void {
    const color = normalizeColor(value);
    if (color === null) return;
    this.edit((draft) => {
      const colors = [
        draft.wallpaper.colors[0],
        draft.wallpaper.colors[1] ?? draft.wallpaper.colors[0],
      ];
      colors[index] = color;
      return { ...draft, wallpaper: { ...draft.wallpaper, type: 'gradient', colors } };
    });
  }

  setColors(first: string, second: string): void {
    this.edit((draft) => ({
      ...draft,
      wallpaper: { ...draft.wallpaper, type: 'gradient', colors: [first, second] },
    }));
  }

  setDim(dim: number): void {
    this.edit((draft) => ({ ...draft, wallpaper: { ...draft.wallpaper, dim } }));
  }

  setAppChosen(name: string, chosen: boolean): void {
    this.edit((draft) => setAppChosen(draft, name, chosen));
  }

  moveApp(name: string, delta: -1 | 1): void {
    this.edit((draft) => moveApp(draft, name, delta));
  }

  /** Minutos no Modo Dormir antes de acordar sozinho (0 = só com tecla); fora de 0 a 720 vira o limite mais próximo. */
  setSleepMax(minutes: number): void {
    const value = Number.isFinite(minutes) ? Math.round(minutes) : 0;
    this.edit((draft) => ({
      ...draft,
      sleep: { maxMinutes: Math.min(SLEEP_MAX_MINUTES, Math.max(0, value)) },
    }));
  }

  /** O aviso do último pedido some quando a pessoa o dispensa ou muda de tela. */
  clearNotice(): void {
    this._notice.set(null);
  }

  private edit(change: (draft: LivreConfig) => LivreConfig): void {
    const draft = this._draft();
    if (!draft) return;
    this._draft.set(change(draft));
    this._notice.set(null);
  }

  /**
   * Espera a resposta de um pedido e só a entrega se a conta e a TV ainda são as de quando ele saiu: do contrário nada do que ele
   * traz (sucesso ou erro) pode tocar a tela nova. Toda mudança de signal depois de um `await` passa por aqui.
   */
  private async live<T>(epoch: number, pending: Promise<T>): Promise<T> {
    try {
      const value = await pending;
      if (epoch !== this.epoch) throw new StaleRequest();
      return value;
    } catch (error) {
      if (epoch !== this.epoch) throw new StaleRequest();
      throw error;
    }
  }

  /**
   * Adota o estado que o servidor devolveu. O rascunho nasce dele na primeira vez e depois só muda quando a pessoa edita
   * (ou quando `resync` pede, ao guardar, para o rascunho ficar igual ao que foi guardado). Um estado de outra conta ou TV é
   * descartado.
   */
  private adopt(view: TvLivreView, epoch: number, resync = false): void {
    if (epoch !== this.epoch) throw new StaleRequest();
    this._view.set(view);
    if (this._draft() === null || resync) this._draft.set(normalizeApps(view.config));
    if (!view.hasPhoto) this._photoUrl.set(null);
    else if (this._photoUrl() === null) void this.loadPhoto(epoch);
  }

  private async loadPhoto(epoch: number): Promise<void> {
    try {
      const blob = await this.api.photo();
      const url = blob ? await toDataUrl(blob) : null;
      if (epoch === this.epoch) this._photoUrl.set(url);
    } catch {
      // Sem a miniatura a pré-visualização mostra o degradê; a foto em si não se perdeu.
    }
  }

  /** Um pedido por vez; devolve se deu certo. O texto que o pedido devolve é o aviso de sucesso. */
  private async run(
    action: LivreAction,
    task: (epoch: number) => Promise<string>,
  ): Promise<boolean> {
    if (this._busy() !== null) return false;
    const epoch = this.epoch;
    this._busy.set(action);
    this._notice.set(null);
    try {
      const text = await task(epoch);
      if (epoch !== this.epoch) return false;
      this._notice.set({ kind: 'ok', text });
      return true;
    } catch (error) {
      if (epoch === this.epoch && !(error instanceof StaleRequest)) {
        const text =
          error instanceof LocalFailure ? error.message : describeLivreFailure(error).message;
        this._notice.set({ kind: 'error', text });
      }
      return false;
    } finally {
      if (epoch === this.epoch) this._busy.set(null);
    }
  }

  private reset(): void {
    this.epoch++;
    this._view.set(null);
    this._shortcuts.set([]);
    this._draft.set(null);
    this._photoUrl.set(null);
    this._loading.set(false);
    this._loadFailure.set(null);
    this._busy.set(null);
    this._notice.set(null);
  }
}
