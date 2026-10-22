import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import {
  InstallEnvInput,
  isAndroid,
  iosBrowser,
  isIos,
  isMobileDevice,
  isStandalone,
  readInstallEnv,
} from './install-env';

/**
 * Como a pessoa instala neste aparelho agora: `none` não há o que oferecer (já instalado, computador sem instalação
 * pelo navegador, ou navegador sem suporte) · `native` o navegador entregou o pedido de instalação (Chromium) ·
 * `ios-safari` Compartilhar > Adicionar à Tela de Início no Safari · `ios-other` o mesmo no Chrome, no Edge ou no
 * Firefox do iPhone (iOS 16.4 ou mais novo) · `ios-in-app` o app está dentro de outro (Instagram, Facebook...), que
 * não tem essa opção: o primeiro passo é abrir no Safari.
 */
export type InstallMode =
  'none' | 'native' | 'android-manual' | 'ios-safari' | 'ios-other' | 'ios-in-app';

/** Resultado de pedir a instalação nativa. `unavailable`: não havia pedido guardado, ou o navegador o recusou. */
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

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

/** Chave da memória da dica neste aparelho. A versão no nome deixa trocar o formato sem ler lixo antigo. */
export const INSTALL_HINT_KEY = 'uniover.install-hint.v1';

/** Depois de "Agora não" a folha não volta sozinha por este tempo (14 dias). */
export const INSTALL_HINT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

interface HintMemory {
  /** Instante (ms desde 1970) do último "Agora não". */
  readonly dismissedAt?: number;
  /** "Não mostrar de novo": a folha nunca mais abre sozinha. */
  readonly never?: boolean;
  /** A pessoa confirmou que já instalou ou aceitou o pedido nativo neste aparelho. */
  readonly installed?: boolean;
}

function readMemory(): HintMemory {
  try {
    const raw = globalThis.localStorage?.getItem(INSTALL_HINT_KEY);
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

function writeMemory(memory: HintMemory | null): void {
  try {
    if (memory) globalThis.localStorage?.setItem(INSTALL_HINT_KEY, JSON.stringify(memory));
    else globalThis.localStorage?.removeItem(INSTALL_HINT_KEY);
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

  private readonly promptEvent = signal<InstallPromptEvent | null>(null);
  private readonly standalone = signal(isStandalone(this.env));
  private readonly memory = signal<HintMemory>(readMemory());
  /** A folha automática já abriu nesta página: mesmo sem armazenamento ela não repete. */
  private readonly autoShown = signal(false);
  /** Quantas telas pediram para a folha automática esperar (o treino ao vivo, por exemplo). */
  private readonly holds = signal(0);
  private readonly _sheet = signal<'auto' | 'manual' | null>(null);

  /** Celular ou tablet: só neles a folha abre sozinha; nas linhas de Ajustes e Personalizar vale em qualquer um. */
  readonly mobile = isMobileDevice(this.env);

  readonly mode = computed<InstallMode>(() => {
    if (this.standalone()) return 'none';
    if (this.promptEvent()) return 'native';
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
   * Se a folha pode abrir sozinha: há o que oferecer, é um celular, a pessoa não pediu para parar, o último
   * "Agora não" tem mais de 14 dias, ela ainda não abriu nesta página e nenhuma tela pediu para esperar. Não olha o
   * relógio: quem decide a hora é `autoOpenAllowed`. Quando o pedido de espera termina, isto volta a ser verdadeiro e o
   * prazo de abertura recomeça do zero.
   */
  readonly autoEligible = computed(
    () =>
      this.mobile &&
      this.mode() !== 'none' &&
      !this.memory().never &&
      !this.memory().installed &&
      !this.autoShown() &&
      !this.autoHeld(),
  );

  constructor() {
    // O iOS não dispara `appinstalled`; abrir como app é a confirmação durável de que a instalação deu certo.
    if (this.standalone()) this.acknowledgeInstalled();
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Liga os ouvintes do navegador; pode ser chamado mais de uma vez. */
  start(): void {
    const win = this.win;
    if (this.started || !win) return;
    this.started = true;

    const onPrompt = (event: Event) => {
      // Guarda o pedido para a pessoa decidir na hora certa; sem isto o Chromium mostraria o dele na hora.
      event.preventDefault();
      this.promptEvent.set(event as InstallPromptEvent);
    };
    const onInstalled = () => this.acknowledgeInstalled();
    win.addEventListener('beforeinstallprompt', onPrompt);
    win.addEventListener('appinstalled', onInstalled);

    // O app pode passar a rodar como instalado sem recarregar (a media query muda).
    const query = this.listenStandalone();
    this.teardown = () => {
      win.removeEventListener('beforeinstallprompt', onPrompt);
      win.removeEventListener('appinstalled', onInstalled);
      query?.();
    };
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
        if (mql.matches) this.acknowledgeInstalled();
      };
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    } catch {
      return null;
    }
  }

  /**
   * Hora de abrir sozinha: `autoEligible` e o último "Agora não" fora dos 14 dias. Separada do signal porque depende
   * do relógio, que não é reativo.
   */
  autoOpenAllowed(now: number = Date.now()): boolean {
    if (!this.autoEligible()) return false;
    const dismissedAt = this.memory().dismissedAt;
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

  /** Abre a folha sozinha; conta como "já mostrada nesta página". */
  openAuto(): void {
    if (this._sheet() !== null) return;
    this.autoShown.set(true);
    this._sheet.set('auto');
  }

  /**
   * A pessoa tocou numa linha ("Adicionar à tela de início"): abre sempre, sem olhar "Agora não" nem "nunca". Conta
   * como vista: ao fechar, a folha automática não pode aparecer logo atrás dela.
   */
  open(): void {
    if (this.mode() === 'none' || this._sheet() !== null) return;
    this.autoShown.set(true);
    this._sheet.set('manual');
  }

  /** A folha terminou de sair. */
  closeSheet(): void {
    this._sheet.set(null);
  }

  /** "Agora não" (ou Esc): não volta sozinha por 14 dias. */
  dismiss(now: number = Date.now()): void {
    this.remember({ ...this.memory(), dismissedAt: now });
  }

  /** "Não mostrar de novo": a folha nunca mais abre sozinha (as linhas de Ajustes e Personalizar continuam). */
  never(): void {
    this.remember({ ...this.memory(), never: true });
  }

  /** O app foi instalado ou a instalação foi aceita: não oferece a dica automática neste aparelho. */
  acknowledgeInstalled(): void {
    this.standalone.set(true);
    this.promptEvent.set(null);
    this.remember({ installed: true });
  }

  /** Pede a instalação nativa. Só existe no modo `native`; o pedido do navegador vale uma vez. */
  async prompt(): Promise<InstallOutcome> {
    const event = this.promptEvent();
    if (!event) return 'unavailable';
    // O pedido só pode ser usado uma vez: o navegador entrega outro quando achar que cabe.
    this.promptEvent.set(null);
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'dismissed') this.dismiss();
      else this.acknowledgeInstalled();
      return outcome;
    } catch {
      return 'unavailable';
    }
  }

  private remember(memory: HintMemory): void {
    this.memory.set(memory);
    writeMemory(memory);
  }
}
