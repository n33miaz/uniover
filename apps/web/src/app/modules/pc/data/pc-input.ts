import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { tick } from '../input/haptics';
import { LiveTyper, type TextDiff } from '../input/live-typing';
import { PcArmed } from './pc-armed';
import { CANCELLED, type PcFailure } from './pc-failure';
import { slideKeys } from './pc-slides';
import { PcStore } from './pc-store';
import type { PcHoldableKey, PcKey, PcKeyOptions, PcModifier } from './pc-types';

/** O que falhou: `edit` foi o texto do teclado do celular (apagar e digitar), `key` uma tecla da tela. */
export type InputKind = 'edit' | 'key';

/** Teclas na fila a partir das quais a repetição (da tela ou do teclado do celular) pula a rodada em vez de empilhar. */
export const MAX_KEYS_IN_FLIGHT = 2;

/**
 * Com a repetição em lotes (`pc.key.v2`) cada pedido carrega até `BATCH_MAX` apertos, então a rodada só sai com a fila vazia:
 * pedidos em voo mais lotes esperando passariam de um lote a executar depois de o dedo sair.
 */
export const MAX_BATCHES_IN_FLIGHT = 1;

/** Quanto o "Soltar" espera as teclas que a fila ainda não entregou ao PC. */
export const RELEASE_SETTLE_MS = 1_500;

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
  private readonly failureListeners = new Set<
    (failure: PcFailure, kind: InputKind, droppedEdits: boolean) => void
  >();
  private readonly divergeListeners = new Set<() => void>();
  private readonly idleListeners = new Set<() => void>();

  private readonly typer = new LiveTyper(
    {
      key: (key, modifiers, options) =>
        this.sameAccount(() =>
          options === undefined
            ? this.store.sendKey(key, modifiers)
            : this.store.sendKey(key, modifiers, options),
        ),
      text: (text) => this.sameAccount(() => this.store.sendText(text)),
      edit: (edit) => this.sameAccount(() => this.store.sendTextEdit(edit)),
      canEdit: () => this.store.supportsTextV2(),
    },
    {
      failed: (failure, kind, droppedEdits) =>
        this.failureListeners.forEach((listener) => listener(failure, kind, droppedEdits)),
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
    const modifiers = this.armed.take(extra);
    this.typer.key(key, modifiers);
    // Uma tecla com modificador (Ctrl+Z, Ctrl+Backspace...) mexe no texto do PC sem o campo saber.
    if (modifiers.length > 0) this.diverge();
    return true;
  }

  /**
   * Há um modificador segurado no PC (o Alt do "Trocar janela"): qualquer tecla que saísse agora seria Alt+tecla. As telas
   * que mandam teclas soltas (a Mídia) desligam os botões enquanto isto vale, como a tela do mouse, e `plain` e `gotoSlide`
   * recusam por conta própria.
   */
  readonly held = computed(() => this.store.heldKeys().length > 0);

  /**
   * Uma tecla do catálogo com só os modificadores dela: as teclas armadas na tela do mouse NÃO valem (quem aperta "Voltar 10 s"
   * não quer um Ctrl+J porque deixou o Ctrl armado). Há uma vibração curta. Devolve `false` quando nada foi enviado.
   */
  plain(key: PcKey, modifiers: readonly PcModifier[] = [], options?: PcKeyOptions): boolean {
    if (!this.store.canSend() || this.held()) return false;
    tick();
    if (options === undefined) this.typer.key(key, modifiers);
    else this.typer.key(key, modifiers, options);
    this.diverge();
    return true;
  }

  /** "Ir ao slide N": os dígitos e o Enter, na ordem da fila. Só para PC que entende `pc.key.v2`; quem chama confere. */
  gotoSlide(slide: number): boolean {
    if (!this.store.canSend() || this.held()) return false;
    tick();
    for (const key of slideKeys(slide)) this.typer.key(key, []);
    this.diverge();
    return true;
  }

  /**
   * `count` apertos da mesma tecla num pedido só (Backspace e setas seguradas); os modificadores são os que quem chama já
   * gastou. Só para PC que entende `pc.key.v2`: quem chama confere (`store.supportsKeyV2`).
   */
  sendKeyRepeat(key: PcKey, count: number, modifiers: readonly PcModifier[] = []): void {
    this.typer.key(key, modifiers, { repeat: count });
  }

  /**
   * Segura um modificador (`DOWN`) na ordem da fila: o que se digitou antes sai antes. O `UP` NÃO entra na fila (ver
   * `release`). Devolve `false` quando nada foi enviado.
   */
  hold(key: PcHoldableKey): boolean {
    if (!this.store.canSend()) return false;
    tick();
    this.typer.key(key, [], { action: 'DOWN' });
    return true;
  }

  /**
   * Solta um modificador segurado. Espera, por pouco tempo, as teclas que a fila ainda não entregou ao PC (um "Próxima, Soltar"
   * rápido não pode soltar o Alt antes do último Tab) e então solta pelo caminho próprio do store, que nunca é cancelado pela
   * fila. Passado o prazo, solta mesmo assim.
   */
  async release(
    key: PcHoldableKey,
    options: { readonly discard?: readonly PcKey[] } = {},
  ): Promise<PcFailure | null> {
    await this.settle(RELEASE_SETTLE_MS);
    // Passado o prazo, o que ainda esperava na fila (os Tab de uma fila presa) não vai depois da soltura, como tecla solta.
    if (options.discard) this.typer.discardKeys(options.discard);
    return this.store.releaseKey(key);
  }

  /** Espera a fila esvaziar, por no máximo `maxMs`. */
  private settle(maxMs: number): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.onIdle(done);
      const timer = setTimeout(done, maxMs);
    });
  }

  /** Um atalho do catálogo: a tecla com os modificadores dele e os armados. Qualquer atalho pode mexer no texto do PC. */
  shortcut(key: PcKey, modifiers: readonly PcModifier[]): boolean {
    const sent = this.press(key, modifiers);
    if (sent) this.diverge();
    return sent;
  }

  /** O texto do PC pode ter mudado por um caminho que o campo do teclado do celular não viu: ele recomeça do que o PC tem. */
  diverge(): void {
    this.divergeListeners.forEach((listener) => listener());
  }

  /** Quem quer saber de o texto do PC ter mudado por fora do campo. Devolve quem para de ouvir. */
  onDiverge(listener: () => void): () => void {
    this.divergeListeners.add(listener);
    return () => void this.divergeListeners.delete(listener);
  }

  /** Quem quer saber de uma falha de envio (o campo recomeça e a tela avisa). Devolve quem para de ouvir. */
  onFailure(
    listener: (failure: PcFailure, kind: InputKind, droppedEdits: boolean) => void,
  ): () => void {
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
