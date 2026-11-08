import { Injectable, effect, inject, untracked } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { tick } from '../input/haptics';
import { LiveTyper, type TextDiff } from '../input/live-typing';
import { PcArmed } from './pc-armed';
import { CANCELLED, type PcFailure } from './pc-failure';
import { PcStore } from './pc-store';
import type { PcKey, PcModifier } from './pc-types';

/** O que falhou: `edit` foi o texto do teclado do celular (apagar e digitar), `key` uma tecla da tela. */
export type InputKind = 'edit' | 'key';

/**
 * A fila de tudo o que se digita no PC: o teclado do celular (ao vivo), as teclas da barra, o painel de teclas, os atalhos.
 * Uma só para o app inteiro, para que um atalho tocado depois do texto digitado nunca passe na frente dele, mesmo vindo de
 * outra aba. Junta o que se digita enquanto um pedido está em voo (`LiveTyper`) e, trocando a conta, descarta o que ainda
 * não saiu: a entrada de uma pessoa nunca chega ao PC da outra.
 */
@Injectable({ providedIn: 'root' })
export class PcInput {
  private readonly store = inject(PcStore);
  private readonly session = inject(SessionState);
  private readonly armed = inject(PcArmed);
  /** A conta de quem é o que está na fila. */
  private account = this.session.accountId();
  private readonly failureListeners = new Set<(failure: PcFailure, kind: InputKind) => void>();
  private readonly idleListeners = new Set<() => void>();

  private readonly typer = new LiveTyper(
    {
      key: (key, modifiers) => this.sameAccount(() => this.store.sendKey(key, modifiers)),
      text: (text) => this.sameAccount(() => this.store.sendText(text)),
    },
    {
      failed: (failure, kind) =>
        this.failureListeners.forEach((listener) => listener(failure, kind)),
      idle: () => this.idleListeners.forEach((listener) => listener()),
    },
  );

  constructor() {
    effect(() => {
      const current = this.session.accountId();
      untracked(() => {
        if (current === this.account) return;
        this.account = current;
        this.typer.clear();
      });
    });
  }

  /** Pedidos na fila mais o que está em voo (a repetição de tecla espera por este número). */
  get pending(): number {
    return this.typer.pending;
  }

  /** Há como mandar entrada ao PC agora. */
  get canSend(): boolean {
    return this.store.canSend();
  }

  /** O campo do teclado do celular mudou: apagar `erase` e digitar o resto. */
  edit(diff: TextDiff): void {
    this.typer.edit(diff);
  }

  /** Uma tecla com estes modificadores (os armados não entram: quem chama já os gastou). */
  sendKey(key: PcKey, modifiers: readonly PcModifier[] = []): void {
    this.typer.key(key, modifiers);
  }

  /**
   * Uma tecla da tela: as teclas armadas valem para ela e se soltam, e há uma vibração curta. Sem PC conectado nada é gasto.
   * Devolve `false` quando nada foi enviado.
   */
  press(key: PcKey, extra: readonly PcModifier[] = []): boolean {
    if (!this.store.canSend()) return false;
    tick();
    this.typer.key(key, this.armed.take(extra));
    return true;
  }

  /** Quem quer saber de uma falha de envio (o campo recomeça e a tela avisa). Devolve quem para de ouvir. */
  onFailure(listener: (failure: PcFailure, kind: InputKind) => void): () => void {
    this.failureListeners.add(listener);
    return () => void this.failureListeners.delete(listener);
  }

  /** Quem quer saber de a fila esvaziar. Devolve quem para de ouvir. */
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => void this.idleListeners.delete(listener);
  }

  /** Um pedido de uma conta que já não é a atual não vai ao PC desta. */
  private sameAccount(call: () => Promise<PcFailure | null>): Promise<PcFailure | null> {
    return this.session.accountId() === this.account ? call() : Promise.resolve(CANCELLED);
  }
}
