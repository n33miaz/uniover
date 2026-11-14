import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../../../core/session/session-state';
import { TvAdbPermission } from '../../data/tv-adb-permission';
import { TvApi } from '../../data/tv-api';
import { TvPresence } from '../../data/tv-presence';
import { TvSelection } from '../../data/tv-selection';
import type { TvShortcut } from '../../data/tv-types';
import {
  LivreAppRow,
  appRows,
  buildConfig,
  controlPackages,
  groupApps,
  moveApp,
  normalizeApps,
  previewApps,
  replaceApps,
  sameConfig,
  setAppChosen,
} from './livre-config';
import { describeLivreFailure } from './livre-errors';
import { TvLivreApi } from './livre-api';
import { LIVRE_PHOTO_REDUCER } from './photo-fit';
import {
  DEFAULT_LIVRE_CONFIG,
  LAUNCHER_LEVEL_LATEST,
  LivreConfig,
  SLEEP_MAX_MINUTES,
  TvLivreView,
  normalizeColor,
} from './livre-types';

/** O que está em andamento: um pedido por vez, porque cada um mexe numa TV real e os longos levam dezenas de segundos. */
export type LivreAction =
  | 'refresh'
  | 'apply'
  | 'install'
  | 'update'
  | 'set-home'
  | 'restore'
  | 'sleep'
  | 'sleep-time'
  | 'show'
  | 'photo';

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
  private readonly presence = inject(TvPresence);
  private readonly adbPermission = inject(TvAdbPermission);
  private readonly doc = inject(DOCUMENT);
  private readonly session = inject(SessionState);
  private readonly selection = inject(TvSelection);
  private readonly reducer = inject(LIVRE_PHOTO_REDUCER);

  private epoch = 0;
  private started = false;

  private readonly _view = signal<TvLivreView | null>(null);
  private readonly _shortcuts = signal<readonly TvShortcut[]>([]);
  /** Os atalhos acima são da leitura de agora (e não da visita anterior): só então valem para copiar a ordem do controle. */
  private readonly _shortcutsCurrent = signal(false);
  private readonly _draft = signal<LivreConfig | null>(null);
  private readonly _photoUrl = signal<string | null>(null);
  private readonly _loading = signal(false);
  private readonly _loadFailure = signal<string | null>(null);
  private readonly _busy = signal<LivreAction | null>(null);
  private readonly _notice = signal<LivreNotice | null>(null);
  /** A configuração foi guardada, mas a TV não a aplicou (falha na hora de aplicar): ainda falta tentar de novo. */
  private readonly _unapplied = signal(false);
  private readonly _showPrompt = signal(false);
  /** O launcher mais novo que existe já foi instalado e o nível não subiu: a versão nova ainda não foi publicada. */
  private readonly _updateStale = signal(false);
  private supportRetry: ReturnType<typeof setTimeout> | null = null;
  private supportAttempts = 0;

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
  /** O último "Aplicar" só gravou (havia outro app na frente da TV): a tela oferece "Mostrar agora na TV". */
  readonly showPrompt = this._showPrompt.asReadonly();

  /**
   * O tempo do Modo Dormir vale na hora, sem "Aplicar": o agente aceita o tempo no pedido de dormir e o launcher da TV sabe
   * usá-lo (nível 2). Sem isso o tempo continua indo no rascunho e só vale depois de "Aplicar na TV", como antes.
   */
  readonly quickSleep = computed(() => {
    const view = this._view();
    return view !== null && view.extended && (view.launcherLevel ?? 0) >= 2;
  });

  /** Os ajustes que só o launcher de nível 2 conhece (Rede, Entradas, nome na tela da TV) fazem efeito. */
  readonly launcherExtras = computed(() => (this._view()?.launcherLevel ?? 0) >= 2);

  /** Há launcher mais novo para instalar: o agente leu o nível na TV e ele está abaixo do que esta versão espera. */
  readonly updateAvailable = computed(() => {
    const view = this._view();
    return (
      view !== null &&
      !this._updateStale() &&
      view.installed &&
      view.launcherLevel !== null &&
      view.launcherLevel < LAUNCHER_LEVEL_LATEST
    );
  });

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

  /** Os apps da fileira do controle que a Home da TV pode ter (vazio até os atalhos chegarem). */
  readonly controlApps = computed(() => {
    const view = this._view();
    return view && this._shortcutsCurrent() ? controlPackages(this._shortcuts(), view.apps) : [];
  });

  /** "Usar os apps do controle" muda alguma coisa: há apps do controle e a Home ainda não é igual a eles. */
  readonly canUseControlApps = computed(() => {
    const draft = this._draft();
    const wanted = this.controlApps();
    if (draft === null || wanted.length === 0) return false;
    return JSON.stringify(draft.apps.items) !== JSON.stringify(wanted);
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

  /**
   * Há o que levar à TV: uma mudança que ainda não foi enviada ou uma configuração guardada que a TV não aplicou. É a
   * pergunta da barra "Aplicar na TV". A falha de aplicar só é lembrada enquanto a tela não é refeita: o estado que o
   * servidor devolve não diz qual revisão está guardada, só a última aplicada.
   */
  readonly pending = computed(() => this.dirty() || this._unapplied());

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
    this.supportAttempts = 0;
    // Esta tela não passa pelo `TvStore`: o toque nela também é o sinal de presença que deixa o agente reconectar o ADB.
    this.doc.addEventListener('pointerdown', this.onTouch, { capture: true, passive: true });
    this.doc.addEventListener('keydown', this.onTouch, { capture: true, passive: true });
    void this.load();
  }

  stop(): void {
    this.started = false;
    this.doc.removeEventListener('pointerdown', this.onTouch, { capture: true });
    this.doc.removeEventListener('keydown', this.onTouch, { capture: true });
    this.clearSupportRetry();
  }

  private readonly onTouch = () => {
    void this.presence.signal();
  };

  /**
   * Lê o estado e os atalhos da TV (para nome e ícone dos apps). Sem estado ainda, mostra a espera; com ele, atualiza por
   * baixo. A tela abre assim que o estado chega: os atalhos (nome e ícone) vêm em seguida, e até lá os apps aparecem com o
   * nome tirado do pacote.
   */
  async load(): Promise<void> {
    const epoch = this.epoch;
    if (this._view() === null) this._loading.set(true);
    this._loadFailure.set(null);
    // Os atalhos que já havia seguem como reserva de nome e ícone, mas deixam de valer para copiar o controle até a resposta
    // desta leitura chegar (a ordem e as fixações podem ter mudado desde a visita anterior).
    this._shortcutsCurrent.set(false);
    // Sem os atalhos os apps aparecem do mesmo jeito, só com o nome tirado do pacote e a inicial no lugar do ícone.
    const shortcuts = this.tvApi.shortcuts().catch(() => null);
    try {
      const view = await this.api.get();
      if (epoch !== this.epoch) return;
      this.adopt(view, epoch);
      this._loading.set(false);
      const list = await shortcuts;
      if (epoch === this.epoch && list) {
        this._shortcuts.set(list);
        this._shortcutsCurrent.set(true);
      }
    } catch (error) {
      if (epoch !== this.epoch) return;
      const text = this.describe(error, false);
      if (this._view() === null) this._loadFailure.set(text);
      else this._notice.set({ kind: 'error', text });
    } finally {
      if (epoch === this.epoch) this._loading.set(false);
    }
  }

  /** Pede ao agente o estado de agora (instalado, versão, é a tela inicial?). */
  refresh(): Promise<boolean> {
    return this.run('refresh', async (epoch) => {
      // Ler o estado passa pelo agente e só reconecta o ADB logo depois de um sinal de presença: espera o do toque.
      await this.presence.signal();
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
      let applied: TvLivreView;
      try {
        applied = await this.live(epoch, this.api.apply());
      } catch (error) {
        if (error instanceof StaleRequest) throw error;
        const reason = this.describe(error, true);
        this._unapplied.set(true);
        throw new LocalFailure(
          $localize`:@@tv-livre.notice.saved-not-applied:Salvo, mas a TV não aplicou. ${reason}:reason:`,
        );
      }
      this.adopt(applied, epoch);
      this._unapplied.set(false);
      if (applied.applyDeferred) {
        // Havia outro app na frente: a configuração chegou à TV sem tirá-lo dali. Mostrar agora é escolha da pessoa, e só
        // vale se o TV Livre é a tela inicial (a tecla Início leva a ele).
        this._showPrompt.set(applied.isHome);
        return $localize`:@@tv-livre.notice.applied-later:Aplicado. A TV mostra na próxima vez que voltar ao Início.`;
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

  /** Instala por cima o launcher mais novo; a tela inicial continua sendo a que era. */
  update(): Promise<boolean> {
    return this.run('update', async (epoch) => {
      const view = await this.live(epoch, this.api.install());
      this.adopt(view, epoch);
      if (view.launcherLevel !== null && view.launcherLevel < LAUNCHER_LEVEL_LATEST) {
        // Instalou o último que há e o nível não subiu: o launcher novo ainda não foi publicado. O aviso sai (sem isso
        // "Atualizar" reinstalaria o mesmo para sempre) e volta quando a tela é reaberta com a TV ou a conta trocadas.
        this._updateStale.set(true);
        return $localize`:@@tv-livre.notice.update-pending:Instalado o mais novo que há. O launcher novo ainda não foi publicado.`;
      }
      return $localize`:@@tv-livre.notice.updated:TV Livre atualizado.`;
    });
  }

  /** "Mostrar agora na TV": a tecla Início leva ao TV Livre, que relê a configuração gravada. */
  async showNow(): Promise<boolean> {
    this._showPrompt.set(false);
    return this.run('show', async () => {
      await this.tvApi.sendKey('HOME');
      return $localize`:@@tv-livre.notice.shown:Mostrando na TV.`;
    });
  }

  dismissShowPrompt(): void {
    this._showPrompt.set(false);
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
    // O tempo guardado vai junto: o Modo Dormir o usa sem depender da configuração que a TV já tem.
    const minutes = this._view()?.config.sleep.maxMinutes;
    return this.run('sleep', async (epoch) => {
      await this.live(epoch, this.api.sleep(minutes));
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

  /** Copia para a Home os apps fixados no controle, na mesma ordem; a pessoa confere e aplica. */
  useControlApps(): void {
    const wanted = this.controlApps();
    if (wanted.length === 0) return;
    this.edit((draft) => replaceApps(draft, wanted));
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

  /** Descarta o que foi mexido e ainda não foi enviado: o rascunho volta ao que está guardado. */
  discard(): void {
    const view = this._view();
    if (!view || this._busy() !== null) return;
    this._draft.set(normalizeApps(view.config));
    this._notice.set(null);
  /**
   * Troca o tempo do Modo Dormir já valendo: guarda só esse tempo (o resto da configuração fica como foi guardado e o
   * rascunho do que a pessoa está editando não é tocado) e o próximo Modo Dormir o usa. Sem o launcher novo, vira uma
   * edição do rascunho, que só vale depois de "Aplicar na TV".
   */
  setSleepTime(minutes: number): Promise<boolean> {
    const value = Math.min(SLEEP_MAX_MINUTES, Math.max(0, Math.round(minutes) || 0));
    const view = this._view();
    if (!view || !this.quickSleep()) {
      this.setSleepMax(value);
      return Promise.resolve(true);
    }
    return this.run('sleep-time', async (epoch) => {
      const saved = await this.live(
        epoch,
        this.api.saveConfig({ ...view.config, sleep: { maxMinutes: value } }),
      );
      this.adopt(saved, epoch);
      this.edit((draft) => ({ ...draft, sleep: { maxMinutes: value } }));
      // O próprio desenho mostra que valeu; o aviso de rodapé seria barulho.
      return '';
    });
  }

  setClock(change: Partial<LivreConfig['clock']>): void {
    this.edit((draft) => ({ ...draft, clock: { ...draft.clock, ...change } }));
  }

  setIcons(change: Partial<LivreConfig['icons']>): void {
    this.edit((draft) => ({ ...draft, icons: { ...draft.icons, ...change } }));
  }

  setBuiltin(change: Partial<LivreConfig['builtin']>): void {
    this.edit((draft) => ({ ...draft, builtin: { ...draft.builtin, ...change } }));
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
    this._showPrompt.set(false);
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
    if (view.supported === false && view.available) this.scheduleSupportRetry();
    else this.clearSupportRetry();
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
      // Texto vazio: o pedido tem o próprio sinal na tela e não quer o aviso de rodapé.
      this._notice.set(text === '' ? null : { kind: 'ok', text });
      return true;
    } catch (error) {
      if (epoch === this.epoch && !(error instanceof StaleRequest)) {
        const text =
          error instanceof LocalFailure
            ? error.message
            : this.describe(error, action !== 'refresh');
        this._notice.set({ kind: 'error', text });
      }
      return false;
    } finally {
      if (epoch === this.epoch) this._busy.set(null);
    }
  }

  /**
   * A frase da falha. A falta de permissão do ADB também leva a pessoa ao pedido (sem tirar a frase daqui): numa ação dela
   * (`byPerson`: tudo, menos ler o estado) o agente já conectou e o aviso está na TV, então o celular espera o aceite;
   * ao ler o estado, abre a folha que oferece pedir.
   */
  private describe(error: unknown, byPerson: boolean): string {
    const failure = describeLivreFailure(error);
    if (failure.code === 'adb_device_changed') this.adbPermission.deviceChanged();
    if (failure.code === 'adb_unauthorized') {
      if (!byPerson || !this.adbPermission.prompted(() => undefined)) this.adbPermission.denied();
    }
    return failure.message;
  }

  private reset(): void {
    this.clearSupportRetry();
    this.supportAttempts = 0;
    this.epoch++;
    this._view.set(null);
    this._shortcuts.set([]);
    this._shortcutsCurrent.set(false);
    this._draft.set(null);
    this._photoUrl.set(null);
    this._loading.set(false);
    this._loadFailure.set(null);
    this._busy.set(null);
    this._notice.set(null);
    this._unapplied.set(false);
    this._showPrompt.set(false);
    this._updateStale.set(false);
  }

  private scheduleSupportRetry(): void {
    if (!this.started || this.supportRetry !== null || this.supportAttempts >= 8) return;
    this.supportRetry = setTimeout(() => {
      this.supportRetry = null;
      void this.recheckSupport();
    }, 15_000);
  }

  private async recheckSupport(): Promise<void> {
    if (!this.started || this._view()?.supported !== false) return;
    if (this._busy() !== null) {
      this.scheduleSupportRetry();
      return;
    }
    this.supportAttempts++;
    const epoch = this.epoch;
    try {
      const view = await this.api.refresh();
      if (this.started && epoch === this.epoch) this.adopt(view, epoch);
    } catch {
      // A TV pode ainda estar inicializando; a próxima tentativa usa o mesmo estado na tela.
    } finally {
      if (this.started && epoch === this.epoch && this._view()?.supported === false) {
        this.scheduleSupportRetry();
      }
    }
  }

  private clearSupportRetry(): void {
    if (this.supportRetry === null) return;
    clearTimeout(this.supportRetry);
    this.supportRetry = null;
  }
}
