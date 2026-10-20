import { signal } from '@angular/core';

/** O que o carrossel precisa do elemento que rola: medidas e o pedido de rolagem. Separado para testar sem DOM. */
export interface PagerHost {
  width(): number;
  left(): number;
  scrollTo(left: number, smooth: boolean): void;
  reducedMotion(): boolean;
}

export interface StagePagerTuning {
  /** Quanto tempo a rolagem precisa ficar parada (sem dedo na tela) para valer como "terminou". */
  readonly settleMs: number;
  /** Fração da largura que um arrasto precisa andar, na direção da troca, para virar a página que ficou presa no meio. */
  readonly advanceRatio: number;
  /** Prazo para uma rolagem pedida por botão ou tecla chegar; passado ele, a posição é posta à força. */
  readonly fallbackMs: number;
  /** Velocidade do dedo (px por ms) ao soltar a partir da qual o gesto é um toque rápido (flick) e troca a página. */
  readonly flickSpeed: number;
  /** Um flick só vale se o conteúdo já andou ao menos esta fração da largura (descarta tremida). */
  readonly flickMinRatio: number;
}

export const DEFAULT_PAGER_TUNING: StagePagerTuning = {
  settleMs: 140,
  advanceRatio: 0.15,
  fallbackMs: 900,
  flickSpeed: 0.35,
  flickMinRatio: 0.04,
};

/**
 * Estado do carrossel do palco. A rolagem com encaixe é do navegador (gesto, inércia, cancelamento e a disputa com
 * os botões ficam por conta dele); esta classe só garante o que ele não garante:
 *
 * - o ponto de página muda **uma vez**, direto para o destino, quando a troca é pedida por ponto ou tecla (sem
 *   passar pelas páginas do caminho nem voltar enquanto a animação roda);
 * - se o encaixe do navegador não termina (inércia interrompida, rolagem cancelada), a página não fica presa no
 *   meio: passados `settleMs` sem dedo e sem rolar, ela vai para a vizinha se o arrasto passou de `advanceRatio` da
 *   largura, ou volta para a de origem;
 * - um toque rápido e curto troca a página mesmo sem passar da metade da largura (velocidade ao soltar acima de
 *   `flickSpeed`), como em qualquer carrossel de celular; arrasto lento segue a regra do navegador (passou da metade).
 *   A troca do toque rápido só é pedida **depois** que o navegador termina o encaixe dele: uma rolagem pedida no
 *   instante em que o dedo sai disputa com o encaixe que o navegador já começou (e perde, deixando a página voltar
 *   sozinha), então a decisão espera a rolagem parar. Se o navegador já avançou por conta própria, nada é pedido;
 * - a posição acompanha o tamanho: `realign` devolve a página à vista depois de girar a tela, redimensionar ou
 *   voltar de outra aba;
 * - `progress` (0 a n-1, fracionário) alimenta o indicador durante o arrasto.
 */
export class StagePager {
  /** Página escolhida ou à vista (a primeira é 0). */
  readonly page = signal(0);
  /** Posição fracionária da rolagem: 0,5 é meio caminho entre a primeira e a segunda página. */
  readonly progress = signal(0);

  private target: number | null = null;
  /** Página que um toque rápido pediu; vale quando a rolagem parar. */
  private flick: number | null = null;
  private startPage = 0;
  private touching = false;
  private samples: { x: number; t: number }[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: PagerHost,
    readonly count: number,
    private readonly tuning: StagePagerTuning = DEFAULT_PAGER_TUNING,
  ) {}

  /** A rolagem andou (por gesto, inércia, encaixe ou pedido de `goTo`). */
  scrolled(): void {
    const width = this.host.width();
    if (width <= 0) return;
    const left = this.host.left();
    this.progress.set(this.clamp(left / width));
    if (this.target !== null) {
      // Rolagem pedida: o ponto já está no destino; só termina quando a posição chega nele.
      if (Math.abs(left - this.target * width) <= 1) this.finishRequested();
      return;
    }
    this.page.set(this.nearest());
    this.armIdle();
  }

  /** O dedo pousou: enquanto estiver na tela, nada é "terminado" nem corrigido. */
  touchStart(x = 0, time = 0): void {
    this.touching = true;
    this.samples = [{ x, t: time }];
    this.flick = null;
    clearTimeout(this.idleTimer);
    if (this.target === null) this.startPage = this.nearest();
  }

  /** O dedo passou a arrastar: quem manda agora é ele, então o pedido de rolagem em curso é largado. */
  touchDragged(x?: number, time?: number): void {
    if (x !== undefined && time !== undefined) this.samples.push({ x, t: time });
    if (this.samples.length > 8) this.samples.shift();
    if (this.target === null) return;
    this.target = null;
    clearTimeout(this.fallbackTimer);
    this.startPage = this.nearest();
  }

  /**
   * O dedo saiu da tela. Um toque rápido (flick) só anota a página pedida: a troca acontece quando a rolagem para
   * (ver `settle`), para não disputar com o encaixe que o navegador acabou de começar.
   */
  touchEnd(time?: number): void {
    this.touching = false;
    const direction = time === undefined ? 0 : this.flickDirection(time);
    this.samples = [];
    if (direction !== 0 && this.target === null) this.flick = this.startPage + direction;
    this.armIdle();
  }

  /** Leva à página `index` (botão, ponto ou tecla). Animada, salvo `instant` ou "reduzir movimento". */
  goTo(index: number, instant = false): void {
    const page = Math.min(this.count - 1, Math.max(0, Math.round(index)));
    this.flick = null;
    clearTimeout(this.idleTimer);
    clearTimeout(this.fallbackTimer);
    this.page.set(page);
    const width = this.host.width();
    if (width <= 0) {
      this.target = null;
      this.progress.set(page);
      return;
    }
    const left = page * width;
    if (Math.abs(this.host.left() - left) <= 1) {
      this.target = null;
      this.progress.set(page);
      this.startPage = page;
      return;
    }
    this.target = page;
    this.host.scrollTo(left, !(instant || this.host.reducedMotion()));
    this.fallbackTimer = setTimeout(() => {
      if (this.target !== page) return;
      this.host.scrollTo(page * this.host.width(), false);
      this.finishRequested();
    }, this.tuning.fallbackMs);
  }

  /** Põe a página à vista sem animação, no `index` guardado (ao abrir a tela). */
  restore(index: number): void {
    this.goTo(index, true);
  }

  /** O tamanho mudou ou a tela voltou: se a posição saiu do encaixe da página escolhida, devolve. */
  realign(): void {
    if (this.touching || this.target !== null) return;
    const width = this.host.width();
    if (width <= 0) return;
    const left = this.page() * width;
    if (Math.abs(this.host.left() - left) > 1) this.host.scrollTo(left, false);
  }

  destroy(): void {
    clearTimeout(this.idleTimer);
    clearTimeout(this.fallbackTimer);
  }

  /** +1 (próxima) ou -1 (anterior) se o dedo saiu rápido e na mesma direção em que o conteúdo andou; 0 nos demais casos. */
  private flickDirection(time: number): number {
    const last = this.samples[this.samples.length - 1];
    if (!last || this.samples.length < 2 || time - last.t > 80) return 0;
    const first = this.samples.find((sample) => last.t - sample.t <= 100) ?? last;
    const span = last.t - first.t;
    if (span <= 0) return 0;
    const speed = (last.x - first.x) / span;
    const width = this.host.width();
    if (width <= 0 || Math.abs(speed) < this.tuning.flickSpeed) return 0;
    const drift = this.host.left() / width - this.startPage;
    // O dedo vai para a esquerda (velocidade negativa) quando o conteúdo anda para a página seguinte.
    const wanted = speed < 0 ? 1 : -1;
    if (Math.sign(drift) !== wanted || Math.abs(drift) < this.tuning.flickMinRatio) return 0;
    const next = this.startPage + wanted;
    return next < 0 || next > this.count - 1 ? 0 : wanted;
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.settle(), this.tuning.settleMs);
  }

  /** Rolagem parada sem pedido em curso e sem dedo: decide a página (toque rápido) ou resolve o que ficou fora do encaixe. */
  private settle(): void {
    if (this.touching || this.target !== null) return;
    const width = this.host.width();
    if (width <= 0) return;
    const position = this.host.left() / width;
    const nearest = this.nearest();
    const flicked = this.flick;
    this.flick = null;
    // Toque rápido que o navegador não levou adiante (ele voltou à página de origem): a página pedida vale.
    if (flicked !== null && flicked !== nearest) {
      this.goTo(flicked);
      return;
    }
    if (Math.abs(position - nearest) * width <= 1) {
      this.page.set(nearest);
      this.startPage = nearest;
      return;
    }
    const drift = position - this.startPage;
    const advance = Math.abs(drift) >= this.tuning.advanceRatio;
    this.goTo(advance ? this.startPage + Math.sign(drift) : this.startPage);
  }

  private finishRequested(): void {
    clearTimeout(this.fallbackTimer);
    const page = this.target ?? this.page();
    this.target = null;
    this.startPage = page;
    this.page.set(page);
    this.progress.set(page);
  }

  private nearest(): number {
    const width = this.host.width();
    return width > 0 ? this.clamp(Math.round(this.host.left() / width)) : this.page();
  }

  private clamp(value: number): number {
    return Math.min(this.count - 1, Math.max(0, value));
  }
}
