import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject, isDevMode, signal } from '@angular/core';
import { registerServiceWorker } from './register-sw';

/** Liga o service worker só fora do modo de desenvolvimento; os testes trocam este valor. */
export const PWA_ENABLED = new InjectionToken<boolean>('PWA_ENABLED', {
  providedIn: 'root',
  factory: () => !isDevMode(),
});

/** Tempo curto para a troca de controlador; sem ela, ainda recarregamos para buscar a casca nova. */
export const UPDATE_RELOAD_FALLBACK_MS = 1_500;
export const UPDATE_CHECK_THROTTLE_MS = 60_000;

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
  private lastUpdateCheckAt: number | null = null;
  private reloadTimer: number | undefined;
  private readonly watchedWorkers = new WeakSet<ServiceWorker>();

  readonly updateReady = signal(false);
  readonly applyingUpdate = signal(false);
  readonly updateError = signal(false);

  /** Chamado na inicialização do app; não bloqueia a primeira tela. */
  start(): void {
    const win = this.win;
    if (this.started || !win || !this.enabled) return;
    this.started = true;
    const run = () => this.checkForUpdate(win);
    if (win.document.readyState === 'complete') run();
    else win.addEventListener('load', run, { once: true });
    // Uma primeira tentativa offline não impede a próxima: a conexão e a volta à aba são novas oportunidades.
    win.addEventListener('online', run);
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible') run();
    });
  }

  /** O usuário aceitou a versão nova: pede a troca da casca e sempre termina recarregando a página. */
  applyUpdate(): void {
    if (this.applyingUpdate()) return;
    const waiting = this.registration?.waiting;
    this.updateError.set(false);
    this.applyingUpdate.set(true);
    this.applying = true;
    if (waiting) {
      try {
        waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch {
        // Mesmo se o worker terminou entre a leitura e a mensagem, o recarregamento ainda busca a versão publicada.
      }
    } else {
      // Pode ter chegado uma casca nova entre o aviso e o toque; peça nova busca sem deixar o botão virar um beco sem saída.
      try {
        void this.registration?.update()?.catch(() => undefined);
      } catch {
        // `update()` é só uma oportunidade extra: o recarregamento abaixo continua sendo o desfecho do toque.
      }
    }
    if (!this.win) {
      this.reload();
      return;
    }
    this.reloadTimer = this.win.setTimeout(() => this.reload(), UPDATE_RELOAD_FALLBACK_MS);
  }

  private async register(win: Window): Promise<void> {
    if (this.registering || this.registration) return;
    this.registering = true;
    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await registerServiceWorker(win, this.enabled);
    } catch {
      // A rede pode estar indisponível na abertura; os eventos de conexão tentam novamente sem afetar a tela.
      return;
    } finally {
      this.registering = false;
    }
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
      if (this.applying) this.reload();
    });
    // Pede armazenamento durável para o navegador não limpar a casca e os dados locais por falta de uso.
    void win.navigator.storage?.persist?.().catch(() => undefined);
  }

  /** Registra quando ainda não há worker; depois disso, pede uma atualização no máximo uma vez por minuto. */
  private checkForUpdate(win: Window): void {
    if (!this.registration) {
      void this.register(win);
      return;
    }
    const now = Date.now();
    if (this.lastUpdateCheckAt !== null && now - this.lastUpdateCheckAt < UPDATE_CHECK_THROTTLE_MS)
      return;
    this.lastUpdateCheckAt = now;
    void this.registration.update().catch(() => undefined);
  }

  /** Um único caminho de recarregamento protege contra o prazo e `controllerchange` chegarem quase juntos. */
  private reload(): void {
    if (this.reloading) return;
    this.reloading = true;
    if (this.reloadTimer !== undefined) this.win?.clearTimeout(this.reloadTimer);
    try {
      const location = this.win?.location;
      if (!location) throw new Error('Janela indisponível para recarregar.');
      location.reload();
    } catch {
      // Só mostra erro se o último recurso também falhou; enquanto ele é possível, o toque sempre recarrega.
      this.reloading = false;
      this.applying = false;
      this.applyingUpdate.set(false);
      this.updateError.set(true);
    }
  }
}
