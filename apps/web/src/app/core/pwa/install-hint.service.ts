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
import {
  INSTALL_INTENT_KEY,
  INSTALL_MARKER_PARAM,
  InstallPromptCapture,
} from './install-prompt-capture';

export { INSTALL_INTENT_KEY, INSTALL_MARKER_PARAM } from './install-prompt-capture';

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

/** Identifica o atalho que iniciou a janela; o escopo da URL pode mudar dentro do PWA da raiz. */
export const APP_LAUNCH_PARAM = 'uniover_app';
const APP_WINDOW_KEY = 'uniover.app-window';

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

/**
 * Marca (no aparelho) que as chaves do aparelho (`v1`) já foram entregues a uma conta: só a primeira conta que se confirma as
 * herda, uma vez. As chaves `v1` ficam onde estão, para um pacote antigo (ou um recuo de versão) ainda achar a memória.
 */
const ADOPTED_KEY = 'uniover.install-hint.v2.adopted';

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

/** Um "Agora não" no futuro (relógio errado) travaria a dica por muito tempo: passando de agora + 1 dia, não vale. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function sane(dismissedAt: unknown, now: number = Date.now()): number | undefined {
  return typeof dismissedAt === 'number' &&
    Number.isFinite(dismissedAt) &&
    dismissedAt <= now + MAX_CLOCK_SKEW_MS
    ? dismissedAt
    : undefined;
}

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
      dismissedAt: sane(dismissedAt),
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

/**
 * O que a conta sabe de um app: só "Agora não" e "nunca". Se o app está instalado é um fato do aparelho: nunca vem da
 * conta (um `installed` que chegue é ignorado) e nunca vai para ela.
 */
function readRemoteMemory(answer: InstallHintAnswer | undefined): HintMemory {
  return {
    dismissedAt: sane(answer?.dismissedAt),
    never: answer?.never === true ? true : undefined,
  };
}

/** A parte da memória que a conta guarda (sem "instalado"). */
function accountPart(memory: HintMemory): HintMemory {
  return { dismissedAt: memory.dismissedAt, never: memory.never };
}

function sameAccountPart(a: HintMemory, b: HintMemory): boolean {
  return a.dismissedAt === b.dismissedAt && !a.never === !b.never;
}

function readAdopter(): string | null {
  try {
    return globalThis.localStorage?.getItem(ADOPTED_KEY) ?? null;
  } catch {
    return null;
  }
}

function markAdopter(accountId: string): void {
  try {
    globalThis.localStorage?.setItem(ADOPTED_KEY, accountId);
  } catch {
    // Sem armazenamento: nada se grava, e a herança acontece de novo na próxima carga (só vale para a primeira conta).
  }
}

function readSessionShown(win: Window | null): boolean {
  try {
    return win?.sessionStorage?.getItem(INSTALL_HINT_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMemory(scope: InstallScope, memory: HintMemory, accountId: string | null): void {
  try {
    const clean = { ...memory, dismissedAt: sane(memory.dismissedAt) };
    globalThis.localStorage?.setItem(installHintKey(scope, accountId), JSON.stringify(clean));
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
  private readonly capture = inject(InstallPromptCapture);
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
  /** O app da tela aberta agora, para quem precisa dizer de qual módulo é o atalho. */
  readonly screenScope = this.scope.asReadonly();
  /** Escopos em que a pessoa confirmou, nesta página, que o app já está instalado. */
  private readonly ackedScopes = signal<ReadonlySet<InstallScope>>(new Set());
  /** Uma carga pedida para instalar (marcador no endereço): a folha deve abrir assim que o pedido chegar. */
  private readonly offerOnLoad = signal(false);
  private offerTimer: ReturnType<typeof setTimeout> | undefined;

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
  /** A conta cuja resposta foi lida de verdade (sem falha nem prazo): enquanto não for, uma nova chamada tenta de novo. */
  private syncedOk: string | null = null;
  /**
   * O que foi dito antes de se saber de que conta é (a janela instalada que se reconhece ao abrir, uma resposta durante a
   * troca de conta): fica só aqui e entra na memória da conta que se confirmar. Nunca vai para o balde do aparelho.
   */
  private pending: Partial<Record<InstallScope, HintMemory>> = {};
  /** Uma troca de conta está em curso (a anterior saiu, a nova ainda não foi confirmada): nada vai para o balde do aparelho. */
  private buffering = false;
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
      if (!isIos(this.env) && (this.capture.promptEvent() || isAndroid(this.env))) return 'native';
    } else if (this.capture.promptEvent()) return 'native';
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
    this.capture.start();
    if (this.started || !win) return;
    this.started = true;
    void this.checkInstalledRelated();

    // O marcador do endereço já foi lido e tirado cedo por `InstallPromptCapture`, antes do roteador.
    this.offerOnLoad.set(this.capture.requestedOnLoad());
    // O serviço carrega sob demanda: a navegação inicial pode já ter terminado antes deste ponto.
    if (this.router?.navigated) this.scope.set(scopeOfPath(this.router.url));

    // O app pode passar a rodar como instalado sem recarregar (a media query muda).
    const query = this.listenStandalone();
    // O escopo da tela segue a navegação interna; o do documento (`loadScope`) fica o da carga.
    const navigation = this.router?.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.scope.set(scopeOfPath(event.urlAfterRedirects)));
    const stopPrompt = this.capture.onPrompt(() => {
      if (this.offerOnLoad()) this.offerNow();
    });
    const stopInstalled = this.capture.onInstalled(() => this.acknowledgeInstalled(this.loadScope));
    // Carga pedida para instalar mas o navegador não entregou o pedido (já instalado, sem suporte): abre a folha
    // mesmo assim, que mostra o caminho manual ou nada, conforme o modo.
    if (this.offerOnLoad()) {
      if (this.capture.promptEvent()) this.offerNow();
      else this.offerTimer = setTimeout(() => this.offerNow(), INSTALL_OFFER_WAIT_MS);
    }
    this.teardown = () => {
      query?.();
      navigation?.unsubscribe();
      stopPrompt();
      stopInstalled();
      clearTimeout(this.offerTimer);
    };
  }

  private offerNow(): void {
    if (!this.offerOnLoad()) return;
    this.offerOnLoad.set(false);
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
      this.capture.promptEvent.set(null);
    }
    this.ackedScopes.update((acked) => new Set(acked).add(scope));
    this.remember(scope, mergeMemory(this.recall(scope), { installed: true }));
  }

  /**
   * Pede a instalação nativa. Só existe no modo `native`; o pedido do navegador vale uma vez. Se o documento foi
   * carregado com o manifest de outro app, o pedido guardado instalaria o app errado: recarrega a página inteira na raiz
   * do escopo da tela (com o marcador) e a folha reabre lá, com o pedido certo.
   */
  async prompt(): Promise<InstallOutcome> {
    if (this.crossScope()) return this.reloadIntoScope();
    const event = this.capture.promptEvent();
    if (!event) return 'unavailable';
    // O pedido só pode ser usado uma vez: o navegador entrega outro quando achar que cabe.
    this.capture.promptEvent.set(null);
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
    const clean = { ...memory, dismissedAt: sane(memory.dismissedAt) };
    this.storeLocal(scope, clean);
    this.pushToAccount({ [scope]: clean });
  }

  /**
   * Grava no balde da conta. Sem conta conhecida: antes de qualquer sessão (a janela instalada se reconhece ao abrir) vai
   * para o balde do aparelho, que a primeira conta herda; entre trocar de conta e a resposta da nova chegar nada vai para
   * o armazenamento, fica na página (`pending`) até a conta se confirmar, para uma conta nunca escrever no balde de outra.
   */
  private storeLocal(scope: InstallScope, memory: HintMemory): void {
    const clean = { ...memory, dismissedAt: sane(memory.dismissedAt) };
    this.memories.update((all) => ({ ...all, [scope]: clean }));
    const account = this.account();
    if (account !== null) writeMemory(scope, clean, account);
    else if (this.buffering) this.pending = { ...this.pending, [scope]: clean };
    else writeMemory(scope, clean, null); // sem sessão ainda (a janela instalada se reconhece ao abrir): fato do aparelho
  }

  /** Só sobe o que a conta guarda ("Agora não" e "nunca"), nunca "instalado", e só o que não está vazio. */
  private pushToAccount(answers: Partial<Record<InstallScope, HintMemory>>): void {
    if (this._syncedFor() === null || this.buffering || !this.accountGuard()) return;
    const body: Record<string, InstallHintAnswer> = {};
    for (const [scope, memory] of Object.entries(answers)) {
      const part = accountPart(memory);
      if (part.dismissedAt !== undefined || part.never) body[scope] = part;
    }
    if (Object.keys(body).length === 0) return;
    // Melhoria, nunca obrigação: sem rede a resposta fica no aparelho e sobe na próxima leitura bem-sucedida da conta.
    this.api.saveInstallHint(body).catch(() => undefined);
  }

  /**
   * Casa a memória do aparelho com a da conta. A conta vale como a memória de qualquer aparelho (o "Agora não" e o "nunca"
   * dados no iPhone valem no Safari, mesmo que o Safari tenha apagado o que guardava), e o que o aparelho sabe e a conta
   * não sobe. "Instalado" nunca passa pela conta: é do aparelho. Quem hospeda a folha espera até isto acabar
   * (`syncedFor`), com um prazo: se a conta não responde, segue só com o aparelho, e uma chamada seguinte tenta de novo
   * (e então sobe o que ficou para trás). `isCurrent` diz se a sessão ainda é desta conta quando a resposta chega.
   */
  async syncAccount(accountId: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (this.syncedOk === accountId || this.syncingAccount === accountId) return;
    this.syncingAccount = accountId;
    // Outra conta no mesmo aparelho: o que a anterior respondeu não é lido nem enviado por esta.
    if (this.account() !== null && this.account() !== accountId) {
      this.buffering = true;
      this.switchAccount(null);
    }
    try {
      const remote = await this.fetchRemote();
      if (!isCurrent()) return;
      this.accountGuard = isCurrent;
      if (this.account() !== accountId) this.adoptDeviceMemory(accountId);
      this._syncedFor.set(accountId);
      this.correctInstalledMemory();
      if (remote === null) return;
      this.syncedOk = accountId;
      const ahead: Partial<Record<InstallScope, HintMemory>> = {};
      for (const scope of ALL_SCOPES) {
        const local = this.recall(scope);
        const theirs = readRemoteMemory(remote[scope]);
        const merged = mergeMemory(local, theirs);
        if (!sameMemory(merged, local)) this.storeLocal(scope, merged);
        if (!sameAccountPart(accountPart(merged), theirs)) ahead[scope] = merged;
      }
      if (Object.keys(ahead).length > 0) this.pushToAccount(ahead);
    } finally {
      if (this.syncingAccount === accountId) this.syncingAccount = null;
    }
  }

  /** A memória de um escopo no balde atual; lê o armazenamento só na primeira vez de cada escopo. */
  private recall(scope: InstallScope): HintMemory {
    const cached = this.memories()[scope];
    if (cached) return cached;
    const account = this.account();
    const stored = readMemory(scope, account);
    return account === null ? mergeMemory(stored, this.pending[scope] ?? {}) : stored;
  }

  private switchAccount(accountId: string | null): void {
    this.account.set(accountId);
    this.memories.set({});
  }

  /**
   * A conta que se confirma passa a ter o seu balde. A primeira conta neste aparelho herda, uma vez, o que o aparelho
   * sabia sem conta (as chaves `v1`, que ficam onde estão para um pacote antigo ainda as achar) e todas herdam o que a
   * página guardou em `pending` antes de saber quem era. Uma conta que entra depois não herda as chaves `v1`.
   */
  private adoptDeviceMemory(accountId: string): void {
    const firstAccount = readAdopter() === null;
    for (const scope of ALL_SCOPES) {
      const own = readMemory(scope, accountId);
      let merged = mergeMemory(own, this.pending[scope] ?? {});
      if (firstAccount) merged = mergeMemory(merged, readMemory(scope, null));
      if (!sameMemory(merged, {}) && !sameMemory(merged, own))
        writeMemory(scope, merged, accountId);
    }
    if (firstAccount) markAdopter(accountId);
    this.pending = {};
    this.buffering = false;
    this.switchAccount(accountId);
  }

  /**
   * No Chrome Android o ID instalado do manifest vale mais que a memória: se ele diz que o app NÃO está instalado, o
   * "instalado" que o aparelho guardava (um Treino aberto dentro do PWA da raiz, por exemplo) sai. Roda quando a memória
   * da conta já é a lida e quando a consulta termina, o que vier por último.
   */
  private correctInstalledMemory(): void {
    if (this.installedRelated() !== false || this.account() === null) return;
    if (this.ackedScopes().has(this.loadScope)) return;
    const old = this.recall(this.loadScope);
    if (old.installed) this.storeLocal(this.loadScope, { ...old, installed: undefined });
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
      return ALL_SCOPES.find((scope) => scope === saved) ?? null;
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
      // Corrige memórias antigas gravadas ao abrir Treino dentro do PWA da raiz (depois de a conta ser casada).
      this.correctInstalledMemory();
    } catch {
      // Safari, Firefox e navegadores que recusam a consulta conservam a identidade da janela.
    }
  }
}
