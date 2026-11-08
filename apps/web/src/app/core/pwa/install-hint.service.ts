import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { SCOPED_MODULE_SLUGS, ScopedModuleSlug } from '../modules/module-slugs';
import { InstallHintAnswer, InstallHintAnswers, PreferencesApi } from '../modules/preferences-api';
import {
  InstallEnvInput,
  isAndroid,
  iosBrowser,
  isIos,
  isMobileDevice,
  isStandalone,
  readInstallEnv,
} from './install-env';
import { moduleScopeOf } from './module-head.service';

/**
 * Como a pessoa instala neste aparelho agora: `none` não há o que oferecer (já instalado, computador sem instalação
 * pelo navegador, ou navegador sem suporte) · `native` o navegador entregou o pedido de instalação (Chromium) ·
 * `ios-safari` Compartilhar > Adicionar à Tela de Início no Safari · `ios-other` o mesmo no Chrome, no Edge ou no
 * Firefox do iPhone (iOS 16.4 ou mais novo) · `ios-in-app` o app está dentro de outro (Instagram, Facebook...), que
 * não tem essa opção: o primeiro passo é abrir no Safari.
 */
export type InstallMode =
  'none' | 'native' | 'android-manual' | 'ios-safari' | 'ios-other' | 'ios-in-app';

/**
 * Resultado de pedir a instalação nativa. `unavailable`: não havia pedido guardado, ou o navegador o recusou.
 * `reloading`: o pedido guardado é de outro app (o documento abriu com o manifest de outro escopo); a página está
 * sendo recarregada na raiz do módulo certo e a folha reabre lá.
 */
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable' | 'reloading';

/** Escopo de um app instalável: a raiz (`root`) ou um módulo com manifest próprio. */
export type InstallScope = 'root' | ScopedModuleSlug;

/**
 * Marcador de endereço: "esta carga foi pedida para instalar"; some do endereço assim que a página o lê. Traz um
 * código de uso único, que o botão grava na sessão (`INSTALL_INTENT_KEY`) antes de recarregar: um link externo com
 * `?instalar=...` não bate com nada e não abre a folha.
 */
export const INSTALL_MARKER_PARAM = 'instalar';
/** Identifica o atalho que iniciou a janela; o escopo da URL pode mudar dentro do PWA da raiz. */
export const APP_LAUNCH_PARAM = 'uniover_app';
const APP_WINDOW_KEY = 'uniover.app-window';

/** Chave da sessão (some ao fechar a aba) com o código da recarga pedida pelo botão. */
export const INSTALL_INTENT_KEY = 'uniover.install-intent';

function newIntentToken(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

/** Quanto esperar o pedido do navegador depois de uma carga pedida para instalar, antes de abrir a folha assim mesmo (ms). */
export const INSTALL_OFFER_WAIT_MS = 2500;

/** Troca de página inteira; os testes trocam por um espião (o jsdom não navega). */
export const INSTALL_NAVIGATE = new InjectionToken<(url: string) => void>('INSTALL_NAVIGATE', {
  providedIn: 'root',
  factory: () => {
    const win = inject(DOCUMENT).defaultView;
    return (url) => win?.location.assign(url);
  },
});

function scopeOfPath(path: string): InstallScope {
  return moduleScopeOf(path) ?? 'root';
}

/** O evento `beforeinstallprompt` (ainda não está nos tipos do TypeScript: é do Chromium). */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** O ambiente do aparelho; os testes trocam este valor por um agente de usuário conhecido. */
export const INSTALL_ENV = new InjectionToken<InstallEnvInput>('INSTALL_ENV', {
  providedIn: 'root',
  factory: () => readInstallEnv(inject(DOCUMENT).defaultView),
});

/**
 * Chave da memória da dica da raiz neste aparelho. A versão no nome deixa trocar o formato sem ler lixo antigo. Era a
 * única chave por origem; ficou como a da raiz e cada módulo ganhou a sua (`installHintKey`): o que a pessoa disse
 * do UniOver geral (instalado, "nunca") não vale para o Treino nem para a TV, que são outros apps.
 */
export const INSTALL_HINT_KEY = 'uniover.install-hint.v1';

/** Prefixo da memória por conta: o que uma conta respondeu nunca é lido nem enviado por outra neste aparelho. */
const ACCOUNT_KEY_PREFIX = 'uniover.install-hint.v2';

/**
 * Chave da memória de um escopo. Sem conta (antes de a sessão ser confirmada, e o que versões antigas gravaram) é a do
 * aparelho: a antiga para a raiz, `<antiga>.<módulo>` para cada módulo. Com conta, `uniover.install-hint.v2.<conta>.<app>`.
 */
export function installHintKey(scope: InstallScope, accountId: string | null = null): string {
  if (accountId !== null) return `${ACCOUNT_KEY_PREFIX}.${encodeURIComponent(accountId)}.${scope}`;
  return scope === 'root' ? INSTALL_HINT_KEY : `${INSTALL_HINT_KEY}.${scope}`;
}

/** O endereço de partida de cada app, sem a barra final: a janela que abre nele sem marcador é, com segurança, deste app. */
function isStartPath(scope: InstallScope, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return path === (scope === 'root' ? '/' : `/${scope}`);
}

/**
 * Depois de "Agora não" (ou de a folha automática abrir, ver `openAuto`) ela não volta sozinha por este tempo (30 dias), e só
 * no navegador: dentro do app instalado nunca abre sozinha.
 */
export const INSTALL_HINT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** Chave da sessão (some ao fechar a aba): a folha automática já abriu, em qualquer app, e não repete até a sessão acabar. */
export const INSTALL_HINT_SESSION_KEY = 'uniover.install-hint.session';

/** Quanto esperar a resposta da conta antes de seguir só com a memória do aparelho (ms). */
export const INSTALL_HINT_SYNC_TIMEOUT_MS = 6000;

/** Os apps que a dica conhece: a raiz e cada módulo com manifest próprio. */
const ALL_SCOPES: readonly InstallScope[] = ['root', ...SCOPED_MODULE_SLUGS];

interface HintMemory {
  /** Instante (ms desde 1970) do último "Agora não". */
  readonly dismissedAt?: number;
  /** "Não mostrar de novo": a folha nunca mais abre sozinha. */
  readonly never?: boolean;
  /** A pessoa confirmou que já instalou ou aceitou o pedido nativo neste aparelho. */
  readonly installed?: boolean;
}

function readMemory(scope: InstallScope, accountId: string | null): HintMemory {
  try {
    const raw = globalThis.localStorage?.getItem(installHintKey(scope, accountId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { dismissedAt, never, installed } = parsed as Record<string, unknown>;
    return {
      dismissedAt:
        typeof dismissedAt === 'number' && Number.isFinite(dismissedAt) ? dismissedAt : undefined,
      never: never === true ? true : undefined,
      installed: installed === true ? true : undefined,
    };
  } catch {
    return {};
  }
}

/** Junta duas respostas sem nunca desfazer uma: "instalado" e "nunca" só viram verdadeiros e vale o "Agora não" mais novo. */
function mergeMemory(a: HintMemory, b: HintMemory): HintMemory {
  const dismissedAt =
    a.dismissedAt === undefined || b.dismissedAt === undefined
      ? (a.dismissedAt ?? b.dismissedAt)
      : Math.max(a.dismissedAt, b.dismissedAt);
  return {
    dismissedAt,
    never: a.never || b.never ? true : undefined,
    installed: a.installed || b.installed ? true : undefined,
  };
}

function sameMemory(a: HintMemory, b: HintMemory): boolean {
  return a.dismissedAt === b.dismissedAt && !a.never === !b.never && !a.installed === !b.installed;
}

function readRemoteMemory(answer: InstallHintAnswer | undefined): HintMemory {
  return {
    dismissedAt:
      typeof answer?.dismissedAt === 'number' && Number.isFinite(answer.dismissedAt)
        ? answer.dismissedAt
        : undefined,
    never: answer?.never === true ? true : undefined,
    installed: answer?.installed === true ? true : undefined,
  };
}

function readSessionShown(win: Window | null): boolean {
  try {
    return win?.sessionStorage?.getItem(INSTALL_HINT_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function removeMemory(scope: InstallScope, accountId: string | null): void {
  try {
    globalThis.localStorage?.removeItem(installHintKey(scope, accountId));
  } catch {
    // Sem armazenamento: não há o que apagar.
  }
}

function writeMemory(scope: InstallScope, memory: HintMemory, accountId: string | null): void {
  try {
    globalThis.localStorage?.setItem(installHintKey(scope, accountId), JSON.stringify(memory));
  } catch {
    // Sem armazenamento (modo privado, dados bloqueados): a memória vale só até recarregar a página.
  }
}

/**
 * Ajuda a pessoa a pôr o app na tela de início. O iOS nunca dispara `beforeinstallprompt` nem mostra faixa de
 * instalação (MDN: "This is not supported on iOS"), e o Chromium só entrega o pedido uma vez por carga da página:
 * por isso o serviço precisa existir desde a inicialização (`start()`, chamado por um inicializador do app) e
 * guardar o evento antes de qualquer tela ficar pronta.
 *
 * Aqui só há decisão e memória; quem mostra é a folha (`InstallHintSheet`) e quem a abre sozinha é `InstallHint`.
 */
@Injectable({ providedIn: 'root' })
export class InstallHintService {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly env = inject(INSTALL_ENV);
  private started = false;
  private teardown: (() => void) | null = null;

  // Alguns consumidores isolados da dica não precisam de rotas; na aplicação o Router sempre está presente.
  private readonly router = inject(Router, { optional: true });
  private readonly navigate = inject(INSTALL_NAVIGATE);
  // Sem HttpClient (teste isolado) toda chamada falha, e a resposta fica só no aparelho.
  private readonly api = inject(PreferencesApi);

  /**
   * De qual app é este documento: o escopo do endereço com que ele foi CARREGADO (o servidor escolhe o manifest pelo
   * primeiro segmento). O Chromium só avalia a instalabilidade e entrega `beforeinstallprompt` nessa carga; trocar o
   * `<link rel="manifest">` depois não refaz a conta. Então o pedido guardado vale para este escopo, mesmo que a
   * navegação interna já tenha levado a outro módulo.
   */
  private readonly loadScope: InstallScope = scopeOfPath(this.win?.location.pathname ?? '/');
  /** Identidade desta janela, gravada somente quando ela abre pelo start_url do manifest. */
  private readonly windowScope: InstallScope | null = this.readWindowScope();
  /** O escopo da tela aberta agora (muda com a navegação interna sem recarregar). */
  private readonly scope = signal<InstallScope>(this.loadScope);
  /** Escopos em que a pessoa confirmou, nesta página, que o app já está instalado. */
  private readonly ackedScopes = signal<ReadonlySet<InstallScope>>(new Set());
  /** Uma carga pedida para instalar (marcador no endereço): a folha deve abrir assim que o pedido chegar. */
  private offerOnLoad = false;
  private offerTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly promptEvent = signal<InstallPromptEvent | null>(null);
  private readonly standalone = signal(isStandalone(this.env));
  /** Resultado verificável do Chrome Android para o manifest deste documento. */
  private readonly installedRelated = signal<boolean | null>(null);
  private readonly memories = signal<Readonly<Partial<Record<InstallScope, HintMemory>>>>({});
  /**
   * De quem é a memória local: a da conta da sessão depois de `syncAccount`; antes disso (ou sem sessão) é a do aparelho,
   * que `syncAccount` entrega à primeira conta que se confirmar e esvazia.
   */
  private readonly account = signal<string | null>(null);
  /** A memória do escopo aberto. */
  private readonly memory = computed(() => this.recall(this.scope()));
  /**
   * A tela aberta é de outro app que não o do documento carregado: o pedido guardado (se houver) é do app errado e a
   * instalação só dá certo depois de uma carga completa no escopo certo.
   */
  private readonly crossScope = computed(() => this.scope() !== this.loadScope);
  /**
   * A folha automática já abriu nesta sessão (em qualquer app): não repete ao recarregar nem ao trocar de módulo. Fica na
   * sessão do navegador e, sem ela (armazenamento bloqueado), pelo menos nesta página.
   */
  private readonly autoShown = signal(readSessionShown(this.win));
  /** A conta cuja resposta já foi casada com a do aparelho (ou que não respondeu a tempo): ver `syncAccount`. */
  private readonly _syncedFor = signal<string | null>(null);
  private syncingAccount: string | null = null;
  private accountGuard: () => boolean = () => true;
  /** Quem hospeda a folha espera isto ser a conta da sessão antes de abrir sozinha, para não perguntar o que a conta já sabe. */
  readonly syncedFor = this._syncedFor.asReadonly();
  /**
   * O último "Agora não" (ou abertura automática) de QUALQUER app: o prazo de 30 dias vale para a folha automática de todos
   * juntos, para ela não pedir uma vez por app. "Instalado" e "nunca" seguem por app (cada módulo é outro app).
   */
  private readonly lastDismissedAt = computed(() =>
    ALL_SCOPES.reduce<number | undefined>(
      (latest, scope) => mergeMemory({ dismissedAt: latest }, this.recall(scope)).dismissedAt,
      undefined,
    ),
  );
  /** Quantas telas pediram para a folha automática esperar (o treino ao vivo, por exemplo). */
  private readonly holds = signal(0);
  private readonly _sheet = signal<'auto' | 'manual' | null>(null);

  /** Celular ou tablet: só neles a folha abre sozinha; nas linhas de Ajustes e Personalizar vale em qualquer um. */
  readonly mobile = isMobileDevice(this.env);
  /** A tela de outro módulo abriu na janela instalada do UniOver geral. */
  readonly foreignAppWindow = computed(
    () =>
      this.standalone() &&
      (this.crossScope() || (this.windowScope !== null && this.windowScope !== this.scope())),
  );

  readonly mode = computed<InstallMode>(() => {
    if (
      this.ackedScopes().has(this.scope()) ||
      (this.installedRelated() === true && !this.crossScope())
    )
      return 'none';
    // `display-mode` descreve a janela, não o manifest da tela: o PWA geral pode abrir /treino/.
    // Em janelas antigas sem marcador, só a consulta ao Chrome pode resolver a identidade com segurança.
    if (this.standalone() && this.windowScope !== null && this.windowScope === this.scope())
      return 'none';
    if (
      this.standalone() &&
      this.windowScope === null &&
      !this.crossScope() &&
      this.installedRelated() !== false
    )
      return 'none';
    if (this.foreignAppWindow()) {
      if (isAndroid(this.env)) return 'android-manual';
      if (isIos(this.env)) return 'ios-in-app';
    }
    if (this.crossScope()) {
      // Fora do iOS (que instala pelo Compartilhar e lê o manifest na hora), o botão "Instalar" faz a carga completa
      // no escopo certo. Sem pedido guardado e fora do Android (computador com o app geral já instalado, por
      // exemplo) não há como oferecer nada com segurança.
      if (!isIos(this.env) && (this.promptEvent() || isAndroid(this.env))) return 'native';
    } else if (this.promptEvent()) return 'native';
    if (isAndroid(this.env)) return 'android-manual';
    if (!isIos(this.env)) return 'none';
    switch (iosBrowser(this.env)) {
      case 'safari':
        return 'ios-safari';
      case 'in-app':
        return 'ios-in-app';
      default:
        return 'ios-other';
    }
  });

  /**
   * O app roda dentro de um navegador do iPhone/iPad, e não a partir da tela de início (Safari, outro navegador ou um
   * app com navegador embutido). É onde o iOS apaga os dados do site depois de 7 dias sem uso: instalado, ele os poupa.
   */
  readonly iosNotInstalled = computed(() => {
    const mode = this.mode();
    return mode === 'ios-safari' || mode === 'ios-other' || mode === 'ios-in-app';
  });

  /** A folha aberta, e por quem: `auto` (sozinha, respeita "Agora não") ou `manual` (a pessoa tocou numa linha). */
  readonly sheet = this._sheet.asReadonly();

  /** Alguma tela pediu que a folha automática espere (`holdAuto`). */
  readonly autoHeld = computed(() => this.holds() > 0);

  /**
   * Se a folha pode abrir sozinha: há o que oferecer, é um celular, o app NÃO está aberto como instalado (nem o geral nem
   * o de um módulo: dentro do atalho da tela de início ela nunca abre sozinha), a pessoa não disse "nunca" nem "já
   * instalei" para o app da tela, ela ainda não abriu nesta sessão (em app algum) e nenhuma tela pediu para esperar. Quem
   * hospeda a folha espera também a resposta da conta (`syncedFor`). Não olha o relógio: quem decide a hora é
   * `autoOpenAllowed`. Quando o pedido de espera termina, isto volta a ser verdadeiro e o prazo de abertura recomeça do
   * zero.
   */
  readonly autoEligible = computed(
    () =>
      this.mobile &&
      !this.standalone() &&
      this.mode() !== 'none' &&
      !this.memory().never &&
      !this.memory().installed &&
      !this.autoShown() &&
      !this.autoHeld(),
  );

  constructor() {
    // Janela instalada: grava (local e na conta) que este app está instalado. Com o marcador de lançamento sabemos qual
    // atalho abriu a janela; sem ele (o iOS reabre o endereço de quando o atalho foi criado) vale o app do documento só no
    // iOS (sem a consulta do Chrome para confirmar) e só se a janela abriu no endereço de partida desse app: um endereço
    // mais fundo pode ser um link dentro do atalho de outro app, e nesse caso nada se grava.
    if (this.standalone()) {
      const launchedAtStart = isStartPath(this.loadScope, this.win?.location.pathname ?? '/');
      const installedScope =
        this.windowScope ?? (isIos(this.env) && launchedAtStart ? this.loadScope : null);
      if (installedScope !== null) this.acknowledgeInstalled(installedScope);
    }
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Liga os ouvintes do navegador; pode ser chamado mais de uma vez. */
  start(): void {
    const win = this.win;
    if (this.started || !win) return;
    this.started = true;
    void this.checkInstalledRelated();

    // Tem de vir antes de o roteador ler o endereço (este método roda no inicializador do app).
    this.offerOnLoad = this.consumeMarker(win);

    const onPrompt = (event: Event) => {
      // Guarda o pedido para a pessoa decidir na hora certa; sem isto o Chromium mostraria o dele na hora.
      event.preventDefault();
      this.promptEvent.set(event as InstallPromptEvent);
      if (this.offerOnLoad) this.offerNow();
    };
    const onInstalled = () => this.acknowledgeInstalled(this.loadScope);
    win.addEventListener('beforeinstallprompt', onPrompt);
    win.addEventListener('appinstalled', onInstalled);

    // O app pode passar a rodar como instalado sem recarregar (a media query muda).
    const query = this.listenStandalone();
    // O escopo da tela segue a navegação interna; o do documento (`loadScope`) fica o da carga.
    const navigation = this.router?.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.scope.set(scopeOfPath(event.urlAfterRedirects)));
    // Carga pedida para instalar mas o navegador não entregou o pedido (já instalado, sem suporte): abre a folha
    // mesmo assim, que mostra o caminho manual ou nada, conforme o modo.
    if (this.offerOnLoad)
      this.offerTimer = setTimeout(() => this.offerNow(), INSTALL_OFFER_WAIT_MS);
    this.teardown = () => {
      win.removeEventListener('beforeinstallprompt', onPrompt);
      win.removeEventListener('appinstalled', onInstalled);
      query?.();
      navigation?.unsubscribe();
      clearTimeout(this.offerTimer);
    };
  }

  /** Lê e tira o marcador de "instalar" do endereço (sem recarregar nem mexer no histórico). */
  private consumeMarker(win: Window): boolean {
    try {
      const url = new URL(win.location.href);
      const token = url.searchParams.get(INSTALL_MARKER_PARAM);
      if (token === null) return false;
      url.searchParams.delete(INSTALL_MARKER_PARAM);
      win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      // O código é de uso único: vale o que o botão gravou antes de recarregar, e só uma vez.
      const expected = win.sessionStorage?.getItem(INSTALL_INTENT_KEY);
      win.sessionStorage?.removeItem(INSTALL_INTENT_KEY);
      return token !== '' && token === expected;
    } catch {
      return false;
    }
  }

  private offerNow(): void {
    if (!this.offerOnLoad) return;
    this.offerOnLoad = false;
    clearTimeout(this.offerTimer);
    this.open();
  }

  private stop(): void {
    this.teardown?.();
    this.teardown = null;
    this.started = false;
  }

  private listenStandalone(): (() => void) | null {
    try {
      const mql = this.win?.matchMedia?.('(display-mode: standalone)');
      if (!mql?.addEventListener) return null;
      const onChange = () => {
        if (!mql.matches) return;
        // Virou app instalado sem recarregar: a folha automática para já, saiba-se ou não qual atalho abriu a janela.
        this.standalone.set(true);
        if (this.windowScope !== null) this.acknowledgeInstalled(this.windowScope);
      };
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    } catch {
      return null;
    }
  }

  /**
   * Hora de abrir sozinha: `autoEligible`, a janela de fato fora do app instalado (relida agora, não a do início) e o
   * último "Agora não" ou abertura fora dos 30 dias. Separada do signal porque depende do relógio e do navegador, que não
   * são reativos.
   */
  autoOpenAllowed(now: number = Date.now()): boolean {
    if (!this.autoEligible()) return false;
    if (isStandalone(readInstallEnv(this.win))) return false;
    const dismissedAt = this.lastDismissedAt();
    if (dismissedAt === undefined) return true;
    // Relógio que andou para trás: na dúvida, não insiste.
    return now - dismissedAt >= INSTALL_HINT_SNOOZE_MS;
  }

  /**
   * Pede que a folha NÃO abra sozinha enquanto a tela precisar da atenção inteira (o treino ao vivo: um aviso no meio de
   * uma série atrapalha mais que ajuda). Devolve a função que solta o pedido; chamá-la de novo não faz nada. A folha pedida
   * pela pessoa (`open`) não é afetada.
   */
  holdAuto(): () => void {
    let released = false;
    this.holds.update((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      this.holds.update((count) => Math.max(0, count - 1));
    };
  }

  private markShown(): void {
    this.autoShown.set(true);
    try {
      this.win?.sessionStorage?.setItem(INSTALL_HINT_SESSION_KEY, '1');
    } catch {
      // Sem armazenamento na sessão: vale só nesta página.
    }
  }

  /**
   * Abre a folha sozinha. Conta como mostrada na sessão e como respondida: grava já o "Agora não", para que fechar o app, o
   * iOS matar a página ou uma atualização recarregá-la com a folha aberta não faça ela voltar na carga seguinte.
   */
  openAuto(now: number = Date.now()): void {
    if (this._sheet() !== null) return;
    this.markShown();
    this.remember(this.scope(), { ...this.memory(), dismissedAt: now });
    this._sheet.set('auto');
  }

  /**
   * A pessoa tocou numa linha ("Adicionar à tela de início"): abre sempre, sem olhar "Agora não" nem "nunca". Conta
   * como vista: ao fechar, a folha automática não pode aparecer logo atrás dela.
   */
  open(): void {
    if (this.mode() === 'none' || this._sheet() !== null) return;
    this.markShown();
    this._sheet.set('manual');
  }

  /** A folha terminou de sair. */
  closeSheet(): void {
    this._sheet.set(null);
  }

  /** "Agora não" (ou Esc): não volta sozinha por 30 dias. */
  dismiss(now: number = Date.now()): void {
    this.remember(this.scope(), { ...this.memory(), dismissedAt: now });
  }

  /** "Não mostrar de novo": a folha nunca mais abre sozinha (as linhas de Ajustes e Personalizar continuam). */
  never(): void {
    this.remember(this.scope(), { ...this.memory(), never: true });
  }

  /**
   * O app foi instalado ou a instalação foi aceita: não oferece a dica automática deste app neste aparelho. Sem
   * argumento vale o app da tela aberta (a pessoa disse "já instalei"); os sinais do navegador passam o do documento.
   */
  acknowledgeInstalled(scope: InstallScope = this.scope()): void {
    if (scope === this.loadScope) {
      // O pedido guardado e o modo `standalone` são do app do documento.
      this.standalone.set(true);
      this.promptEvent.set(null);
    }
    this.ackedScopes.update((acked) => new Set(acked).add(scope));
    this.remember(scope, { installed: true });
  }

  /**
   * Pede a instalação nativa. Só existe no modo `native`; o pedido do navegador vale uma vez. Se o documento foi
   * carregado com o manifest de outro app, o pedido guardado instalaria o app errado: recarrega a página inteira na raiz
   * do escopo da tela (com o marcador) e a folha reabre lá, com o pedido certo.
   */
  async prompt(): Promise<InstallOutcome> {
    if (this.crossScope()) return this.reloadIntoScope();
    const event = this.promptEvent();
    if (!event) return 'unavailable';
    // O pedido só pode ser usado uma vez: o navegador entrega outro quando achar que cabe.
    this.promptEvent.set(null);
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'dismissed') this.dismiss();
      else this.acknowledgeInstalled(this.loadScope);
      return outcome;
    } catch {
      return 'unavailable';
    }
  }

  private reloadIntoScope(): InstallOutcome {
    const win = this.win;
    if (!win) return 'unavailable';
    const scope = this.scope();
    const token = newIntentToken();
    try {
      win.sessionStorage.setItem(INSTALL_INTENT_KEY, token);
    } catch {
      // Sem armazenamento na sessão: a recarga acontece, mas a folha não reabre sozinha depois dela.
    }
    // Módulo: a raiz dele (`/treino/`). Raiz do UniOver: o endereço atual por inteiro (a tela aberta é um Ajuste, por
    // exemplo), que não deve jogar a pessoa de volta no início nem perder busca e fragmento.
    const url = new URL(scope === 'root' ? win.location.href : `/${scope}/`, win.location.origin);
    url.searchParams.set(INSTALL_MARKER_PARAM, token);
    this.navigate(`${url.pathname}${url.search}${url.hash}`);
    return 'reloading';
  }

  private remember(scope: InstallScope, memory: HintMemory): void {
    this.storeLocal(scope, memory);
    this.pushToAccount({ [scope]: memory });
  }

  private storeLocal(scope: InstallScope, memory: HintMemory): void {
    this.memories.update((all) => ({ ...all, [scope]: memory }));
    writeMemory(scope, memory, this.account());
  }

  private pushToAccount(answers: InstallHintAnswers): void {
    if (this._syncedFor() === null || !this.accountGuard()) return;
    // Melhoria, nunca obrigação: sem rede a resposta fica no aparelho e sobe na próxima carga (`syncAccount`).
    this.api.saveInstallHint(answers).catch(() => undefined);
  }

  /**
   * Casa a memória do aparelho com a da conta, uma vez por conta e por página. A conta vale como a memória de qualquer
   * aparelho (o "Agora não" e o "já instalei" dados no iPhone valem no Safari, mesmo que o Safari tenha apagado o que
   * guardava), e o que o aparelho sabe e a conta não sobe. Quem hospeda a folha espera até isto acabar (`syncedFor`), com um
   * prazo: se a conta não responde, segue só com o aparelho. `isCurrent` diz se a sessão ainda é desta conta quando a resposta chega.
   */
  async syncAccount(accountId: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (this._syncedFor() === accountId || this.syncingAccount === accountId) return;
    this.syncingAccount = accountId;
    // Outra conta no mesmo aparelho: o que a anterior respondeu não é lido nem enviado por esta.
    if (this.account() !== null && this.account() !== accountId) this.switchAccount(null);
    try {
      const remote = await this.fetchRemote();
      if (!isCurrent()) return;
      this.accountGuard = isCurrent;
      this.adoptDeviceMemory(accountId);
      this._syncedFor.set(accountId);
      if (remote === null) return;
      const ahead: Partial<Record<InstallScope, HintMemory>> = {};
      for (const scope of ALL_SCOPES) {
        const local = this.recall(scope);
        const theirs = readRemoteMemory(remote[scope]);
        const merged = mergeMemory(local, theirs);
        if (!sameMemory(merged, local)) this.storeLocal(scope, merged);
        if (!sameMemory(merged, theirs)) ahead[scope] = merged;
      }
      if (Object.keys(ahead).length > 0) this.pushToAccount(ahead);
    } finally {
      if (this.syncingAccount === accountId) this.syncingAccount = null;
    }
  }

  /** A memória de um escopo no balde atual; lê o armazenamento só na primeira vez de cada escopo. */
  private recall(scope: InstallScope): HintMemory {
    return this.memories()[scope] ?? readMemory(scope, this.account());
  }

  private switchAccount(accountId: string | null): void {
    this.account.set(accountId);
    this.memories.set({});
  }

  /**
   * A primeira conta que se confirma neste aparelho herda o que o aparelho sabia sem conta (as chaves antigas e o que a
   * janela instalada gravou antes de a sessão existir), e o aparelho fica sem esse balde: a conta seguinte começa limpa.
   */
  private adoptDeviceMemory(accountId: string): void {
    for (const scope of ALL_SCOPES) {
      const device = readMemory(scope, null);
      const own = readMemory(scope, accountId);
      const merged = mergeMemory(own, device);
      if (!sameMemory(merged, {}) && !sameMemory(merged, own))
        writeMemory(scope, merged, accountId);
      removeMemory(scope, null);
    }
    this.switchAccount(accountId);
  }

  /** A resposta da conta, ou nulo se a API não respondeu a tempo ou falhou (a dica segue com a memória do aparelho). */
  private async fetchRemote(): Promise<InstallHintAnswers | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), INSTALL_HINT_SYNC_TIMEOUT_MS);
      });
      return await Promise.race([this.api.getInstallHint(), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private readWindowScope(): InstallScope | null {
    const win = this.win;
    if (!win || !isStandalone(this.env)) return null;
    try {
      const launched = new URL(win.location.href).searchParams.get(APP_LAUNCH_PARAM);
      if (launched === this.loadScope) win.sessionStorage.setItem(APP_WINDOW_KEY, launched);
      const saved = win.sessionStorage.getItem(APP_WINDOW_KEY);
      return saved === 'root' || saved === 'tv' || saved === 'treino' ? saved : null;
    } catch {
      return null;
    }
  }

  /** No Chrome Android, consulta o ID instalado deste manifest, sem confundir com o PWA geral. */
  private async checkInstalledRelated(): Promise<void> {
    if (!isAndroid(this.env)) return;
    const nav = this.win?.navigator as Navigator & {
      getInstalledRelatedApps?: () => Promise<readonly { platform: string; id?: string }[]>;
    };
    if (typeof nav?.getInstalledRelatedApps !== 'function') return;
    try {
      const apps = await nav.getInstalledRelatedApps();
      const id = new URL(
        this.loadScope === 'root' ? '/' : `/${this.loadScope}/`,
        this.win!.location.origin,
      ).href;
      const installed = apps.some((app) => app.platform === 'webapp' && app.id === id);
      this.installedRelated.set(installed);
      // Corrige memórias antigas gravadas ao abrir Treino dentro do PWA da raiz.
      if (!installed && !this.ackedScopes().has(this.loadScope)) {
        const old = this.recall(this.loadScope);
        if (old.installed) this.remember(this.loadScope, { ...old, installed: undefined });
      }
    } catch {
      // Safari, Firefox e navegadores que recusam a consulta conservam a identidade da janela.
    }
  }
}
