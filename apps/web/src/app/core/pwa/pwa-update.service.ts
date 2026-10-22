import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject, isDevMode, signal } from '@angular/core';
import { registerServiceWorker } from './register-sw';

/** Liga o service worker só fora do modo de desenvolvimento; os testes trocam este valor. */
export const PWA_ENABLED = new InjectionToken<boolean>('PWA_ENABLED', {
  providedIn: 'root',
  factory: () => !isDevMode(),
});

export const UPDATE_ACTIVATION_TIMEOUT_MS = 15_000;

/**
 * Cuida do ciclo de vida do service worker: registra, avisa quando há versão nova esperando e, quando o
 * usuário aceita, manda o worker novo assumir e recarrega a página uma vez.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly enabled = inject(PWA_ENABLED);
  private registration: ServiceWorkerRegistration | undefined;
  private started = false;
  private registering = false;
  private applying = false;
  private reloading = false;
  private activationTimer: number | undefined;
  private readonly watchedWorkers = new WeakSet<ServiceWorker>();

  readonly updateReady = signal(false);
  readonly applyingUpdate = signal(false);
  readonly updateError = signal(false);

  /** Chamado na inicialização do app; não bloqueia a primeira tela. */
  start(): void {
    const win = this.win;
    if (this.started || !win || !this.enabled) return;
    this.started = true;
    const run = () => void this.register(win);
    if (win.document.readyState === 'complete') run();
    else win.addEventListener('load', run, { once: true });
  }

  /** O usuário aceitou a versão nova: o worker que espera passa a controlar e a página recarrega. */
  applyUpdate(): void {
    if (this.applyingUpdate()) return;
    const waiting = this.registration?.waiting;
    if (!waiting) {
      this.updateError.set(true);
      return;
    }
    this.updateError.set(false);
    this.applyingUpdate.set(true);
    this.applying = true;
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      this.applying = false;
      this.applyingUpdate.set(false);
      this.updateError.set(true);
      return;
    }
    this.activationTimer = this.win?.setTimeout(() => {
      this.applyingUpdate.set(false);
      this.updateError.set(true);
    }, UPDATE_ACTIVATION_TIMEOUT_MS);
  }

  private async register(win: Window): Promise<void> {
    if (this.registering || this.registration) return;
    this.registering = true;
    const registration = await registerServiceWorker(win, this.enabled);
    this.registering = false;
    if (!registration) return;
    this.registration = registration;
    const container = win.navigator.serviceWorker;

    // Sem controlador ainda é a primeira instalação: não há "versão nova" para oferecer.
    const checkWaiting = () => {
      if (registration.waiting && container.controller) this.updateReady.set(true);
    };
    const watchInstalling = () => {
      const incoming = registration.installing;
      if (!incoming || this.watchedWorkers.has(incoming)) return;
      this.watchedWorkers.add(incoming);
      const checkInstalled = () => {
        if (incoming.state === 'installed' && container.controller) this.updateReady.set(true);
      };
      incoming.addEventListener('statechange', checkInstalled);
      // The installing worker can finish before updatefound listeners are attached.
      checkInstalled();
    };
    registration.addEventListener('updatefound', watchInstalling);
    // register() may resolve after updatefound, so inspect both states already in progress.
    watchInstalling();
    checkWaiting();
    container.addEventListener('controllerchange', () => {
      if (this.applying && !this.reloading) {
        this.reloading = true;
        if (this.activationTimer) win.clearTimeout(this.activationTimer);
        win.location.reload();
      }
    });
    // Ao voltar para o app, confere se há versão nova (o navegador só confere sozinho ao navegar).
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible')
        void registration.update().catch(() => undefined);
    });
    // Pede armazenamento durável para o navegador não limpar a casca e os dados locais por falta de uso.
    void win.navigator.storage?.persist?.().catch(() => undefined);
  }
}
