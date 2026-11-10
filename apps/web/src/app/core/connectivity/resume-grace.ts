import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';

export interface ResumeGraceConfig {
  /**
   * Quanto dura a carência depois de voltar ao app. Ao voltar do segundo plano o sistema costuma ter derrubado as conexões
   * abertas, e as primeiras requisições saem com "sem resposta" mesmo com a rede boa; este tempo dá ao navegador a chance
   * de abrir conexões novas antes de qualquer aviso aparecer.
   */
  readonly graceMs: number;
}

export const RESUME_GRACE_CONFIG = new InjectionToken<ResumeGraceConfig>('RESUME_GRACE_CONFIG', {
  providedIn: 'root',
  factory: () => ({ graceMs: 4_000 }),
});

/** O que a carência avisa a quem a observa: ela começou (o app voltou) ou terminou (o prazo acabou). */
export type ResumeGraceEvent = 'begin' | 'end';

/**
 * A carência de "voltei ao app": durante ela, falha de rede não vira aviso nenhum (nem faixa, nem aviso flutuante), e quem
 * pode refaz o pedido em silêncio. É o único lugar que sabe quando o app voltou; todo o resto (conectividade, sessão, TV, PC,
 * Treino) só pergunta `active()` ou espera o fim. Cobre a volta de aba oculta (`visibilitychange`) e a página restaurada do
 * cache de ida e volta (`pageshow` persistido, o caso do Safari do iPhone). A primeira carga da página não é uma volta: a
 * faixa de "acordando o servidor" continua valendo na partida a frio.
 */
@Injectable({ providedIn: 'root' })
export class ResumeGrace {
  private readonly config = inject(RESUME_GRACE_CONFIG);
  private readonly doc = inject(DOCUMENT);
  private readonly _active = signal(false);
  private readonly listeners = new Set<(event: ResumeGraceEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** A página já ficou oculta desde a última volta: só então o próximo "visível" é uma volta. */
  private wasHidden = this.doc.visibilityState === 'hidden';

  /** Estamos dentro da carência. */
  readonly active = this._active.asReadonly();

  constructor() {
    const win = this.doc.defaultView;
    const onVisibility = () => {
      if (this.doc.visibilityState === 'hidden') {
        this.wasHidden = true;
        return;
      }
      if (!this.wasHidden) return;
      this.wasHidden = false;
      this.begin();
    };
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) this.begin();
    };
    this.doc.addEventListener('visibilitychange', onVisibility);
    win?.addEventListener('pageshow', onPageShow);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('pageshow', onPageShow);
      clearTimeout(this.timer);
      this.listeners.clear();
    });
  }

  /** Abre a carência (ou a recomeça, se já estava aberta). Chamado pelas voltas; público para os testes e para voltas que só o app sabe. */
  begin(): void {
    clearTimeout(this.timer);
    this._active.set(true);
    this.emit('begin');
    this.timer = setTimeout(() => this.finish(), this.config.graceMs);
  }

  /** Quem quiser reagir ao começo e ao fim da carência; devolve o que cancela. */
  subscribe(listener: (event: ResumeGraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Executa `action` quando a carência terminar (já, se ela não está aberta). Devolve o que cancela a espera. */
  afterEnd(action: () => void): () => void {
    if (!this._active()) {
      action();
      return () => undefined;
    }
    const off = this.subscribe((event) => {
      if (event !== 'end') return;
      off();
      action();
    });
    return off;
  }

  private finish(): void {
    this.timer = undefined;
    this._active.set(false);
    this.emit('end');
  }

  private emit(event: ResumeGraceEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
