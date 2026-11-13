import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** O evento nativo que o Chromium entrega uma vez por carga para instalar o PWA. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Marcador de endereço: "esta carga foi pedida para instalar"; some do endereço assim que a página o lê. Traz um
 * código de uso único, que o botão grava na sessão (`INSTALL_INTENT_KEY`) antes de recarregar: um link externo com
 * `?instalar=...` não bate com nada e não abre a folha.
 */
export const INSTALL_MARKER_PARAM = 'instalar';
/** Chave da sessão (some ao fechar a aba) com o código da recarga pedida pelo botão. */
export const INSTALL_INTENT_KEY = 'uniover.install-intent';

/**
 * Guarda os dois eventos que o navegador entrega só uma vez, antes de o restante da dica de instalação carregar.
 *
 * Esta classe fica no pacote inicial de propósito: atrasar o listener de `beforeinstallprompt` faria o Chromium
 * descartar a única chance de oferecer a instalação. A decisão, a memória e a folha continuam em
 * `InstallHintService`, carregado logo depois.
 */
@Injectable({ providedIn: 'root' })
export class InstallPromptCapture {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly destroyRef = inject(DestroyRef);
  private started = false;
  private offerOnLoad = false;
  private readonly promptListeners = new Set<() => void>();
  private readonly installedListeners = new Set<() => void>();

  readonly promptEvent = signal<InstallPromptEvent | null>(null);
  readonly installed = signal(false);

  constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  start(): void {
    const win = this.win;
    if (this.started || !win) return;
    this.started = true;
    this.offerOnLoad = this.consumeMarker(win);
    win.addEventListener('beforeinstallprompt', this.handlePrompt);
    win.addEventListener('appinstalled', this.handleInstalled);
  }

  /** A dica pesada lê isto depois de carregar; não consome, para poder ser criada uma vez só. */
  requestedOnLoad(): boolean {
    return this.offerOnLoad;
  }

  private stop(): void {
    if (!this.started) return;
    this.win?.removeEventListener('beforeinstallprompt', this.handlePrompt);
    this.win?.removeEventListener('appinstalled', this.handleInstalled);
    this.started = false;
  }

  onPrompt(listener: () => void): () => void {
    this.promptListeners.add(listener);
    if (this.promptEvent()) listener();
    return () => this.promptListeners.delete(listener);
  }

  onInstalled(listener: () => void): () => void {
    this.installedListeners.add(listener);
    if (this.installed()) listener();
    return () => this.installedListeners.delete(listener);
  }

  private readonly handlePrompt = (event: Event): void => {
    // Guarda o pedido para a pessoa decidir na hora certa; sem isto o Chromium mostraria o dele na hora.
    event.preventDefault();
    this.promptEvent.set(event as InstallPromptEvent);
    for (const listener of this.promptListeners) listener();
  };

  private readonly handleInstalled = (): void => {
    this.installed.set(true);
    for (const listener of this.installedListeners) listener();
  };

  /** Lê e tira cedo o marcador, antes de o roteador interpretar o endereço. */
  private consumeMarker(win: Window): boolean {
    try {
      const url = new URL(win.location.href);
      const token = url.searchParams.get(INSTALL_MARKER_PARAM);
      if (token === null) return false;
      url.searchParams.delete(INSTALL_MARKER_PARAM);
      win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      const expected = win.sessionStorage?.getItem(INSTALL_INTENT_KEY);
      win.sessionStorage?.removeItem(INSTALL_INTENT_KEY);
      return token !== '' && token === expected;
    } catch {
      return false;
    }
  }
}
