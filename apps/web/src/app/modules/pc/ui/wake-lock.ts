/** O que o navegador oferece do Screen Wake Lock (o tipo do TypeScript varia com a versão; só se usa isto). */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/**
 * Mantém a tela do aparelho acesa enquanto o controle do PC está em uso (sem isso o celular apaga a tela no meio do uso e
 * a próxima mensagem cai numa tela bloqueada). Onde o navegador não tem a API, ou recusa, não acontece nada: é conforto,
 * nunca requisito. O navegador solta o bloqueio sozinho quando a página some; ao voltar, ele é pedido de novo.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  /** Há um pedido ao navegador ainda sem resposta: nenhum segundo pedido sai enquanto ele não volta. */
  private requesting = false;
  private readonly onVisible = () => {
    if (this.doc.visibilityState === 'hidden') {
      // O navegador solta o bloqueio ao esconder a página; soltar de propósito deixa a conta certa quando ela voltar.
      this.drop();
    } else if (this.wanted) {
      void this.request();
    }
  };

  constructor(private readonly doc: Document) {}

  /** O navegador tem a API (a checagem é por recurso, não por navegador). */
  get supported(): boolean {
    return this.api() !== null;
  }

  /** Há um bloqueio ativo agora. */
  get held(): boolean {
    return this.sentinel !== null;
  }

  /** Pede o bloqueio e o mantém até `stop()`. Chamar de novo não pede outro. */
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.doc.addEventListener('visibilitychange', this.onVisible);
    void this.request();
  }

  stop(): void {
    this.wanted = false;
    this.doc.removeEventListener('visibilitychange', this.onVisible);
    this.drop();
  }

  private drop(): void {
    const held = this.sentinel;
    this.sentinel = null;
    void held?.release().catch(() => undefined);
  }

  private api(): WakeLockLike | null {
    const nav = this.doc.defaultView?.navigator as
      (Navigator & { wakeLock?: WakeLockLike }) | undefined;
    return nav?.wakeLock && typeof nav.wakeLock.request === 'function' ? nav.wakeLock : null;
  }

  private async request(): Promise<void> {
    const api = this.api();
    if (!api || this.requesting || this.sentinel || this.doc.visibilityState === 'hidden') return;
    this.requesting = true;
    try {
      const sentinel = await api.request('screen');
      // Pararam enquanto o pedido ia, ou já há outro bloqueio: o que chegou agora não tem dono e é solto.
      if (!this.wanted || this.sentinel) {
        void sentinel.release().catch(() => undefined);
        return;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
    } catch {
      // recusado (economia de bateria, política da página): a tela apaga como sempre
    } finally {
      this.requesting = false;
    }
  }
}
