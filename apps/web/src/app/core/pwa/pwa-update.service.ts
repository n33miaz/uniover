import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject, isDevMode, signal } from '@angular/core';
import { registerServiceWorker } from './register-sw';

/** Liga o service worker só fora do modo de desenvolvimento; os testes trocam este valor. */
export const PWA_ENABLED = new InjectionToken<boolean>('PWA_ENABLED', {
  providedIn: 'root',
  factory: () => !isDevMode(),
});

/**
 * Cuida do ciclo de vida do service worker: registra, avisa quando há versão nova esperando e, quando o
 * usuário aceita, manda o worker novo assumir e recarrega a página uma vez.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly enabled = inject(PWA_ENABLED);
  private registration: ServiceWorkerRegistration | undefined;
  private applying = false;

  readonly updateReady = signal(false);

  /** Chamado na inicialização do app; não bloqueia a primeira tela. */
  start(): void {
    const win = this.win;
    if (!win || !this.enabled) return;
    const run = () => void this.register(win);
    if (win.document.readyState === 'complete') run();
    else win.addEventListener('load', run, { once: true });
  }

  /** O usuário aceitou a versão nova: o worker que espera passa a controlar e a página recarrega. */
  applyUpdate(): void {
    const waiting = this.registration?.waiting;
    if (!waiting) return;
    this.applying = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  private async register(win: Window): Promise<void> {
    const registration = await registerServiceWorker(win, this.enabled);
    if (!registration) return;
    this.registration = registration;
    const container = win.navigator.serviceWorker;

    // Sem controlador ainda é a primeira instalação: não há "versão nova" para oferecer.
    if (registration.waiting && container.controller) this.updateReady.set(true);
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      incoming?.addEventListener('statechange', () => {
        if (incoming.state === 'installed' && container.controller) this.updateReady.set(true);
      });
    });
    container.addEventListener('controllerchange', () => {
      if (this.applying) win.location.reload();
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
