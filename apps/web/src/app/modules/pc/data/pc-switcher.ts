import { Injectable, computed, inject, signal } from '@angular/core';
import { PcInput } from './pc-input';
import { PcStore } from './pc-store';
import type { PcFailure } from './pc-failure';

/** O modificador que o "Trocar janela" segura. */
const HELD = 'ALT' as const;

/**
 * "Trocar janela" de verdade: o Alt fica apertado enquanto a pessoa escolhe, e cada toque é um Tab (Shift+Tab volta). Soltar
 * o Alt é o que confirma a janela. Um dono só para a folha de atalhos, o painel de teclas e a barra que mostra o estado.
 *
 * O estado vem do store (`heldKeys`), nunca de um sinal próprio: ele já cobre o sinal de vida, a soltura ao sair da tela, ao
 * esconder a página, ao trocar de conta e a perda do PC. Só um PC que entende `pc.key.v2` segura; nos outros o atalho segue
 * sendo o Alt+Tab de um toque.
 */
@Injectable({ providedIn: 'root' })
export class PcSwitcher {
  private readonly store = inject(PcStore);
  private readonly input = inject(PcInput);

  /** O Alt está segurado agora (ou pode estar: o `DOWN` pode ter chegado sem resposta). */
  readonly active = computed(() => this.store.heldKeys().includes(HELD));
  /** "Soltar" foi pedido e ainda não terminou: nenhum Tab novo sai (e os botões se desligam). */
  readonly releasing = signal(false);
  /** O PC conectado entende segurar o Alt. */
  readonly available = computed(() => this.store.supportsKey(HELD, { action: 'DOWN' }));

  /**
   * Segura o Alt e dá o primeiro Tab (abre a lista de janelas). Chamar com a lista já aberta é só mais um Tab. Devolve
   * `false` quando nada foi enviado (sem PC ou sem suporte).
   */
  begin(): boolean {
    if (!this.available() || !this.store.canSend() || this.releasing()) return false;
    // O texto do PC pode mudar por fora do campo do teclado do celular: como em qualquer atalho, o campo recomeça.
    this.input.diverge();
    if (!this.active()) this.input.hold(HELD);
    this.input.sendKey('TAB', []);
    return true;
  }

  /** A janela seguinte da lista. */
  next(): void {
    if (this.active() && !this.releasing()) this.input.sendKey('TAB', []);
  }

  /** A janela anterior da lista (Shift+Tab). */
  previous(): void {
    if (this.active() && !this.releasing()) this.input.sendKey('TAB', ['SHIFT']);
  }

  /** Solta o Alt: o Windows troca para a janela escolhida. */
  async release(): Promise<PcFailure | null> {
    if (this.releasing()) return null;
    this.releasing.set(true);
    try {
      // Os Tab já pedidos saem antes; os que a fila presa não entregou no prazo são descartados, nunca soltos depois do Alt.
      return await this.input.release(HELD, { discard: ['TAB'] });
    } finally {
      this.releasing.set(false);
    }
  }
}
