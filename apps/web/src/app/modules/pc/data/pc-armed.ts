import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { PC_MODIFIERS, type PcModifier } from './pc-types';

/**
 * As teclas Ctrl, Shift, Alt e Win "armadas": ficam marcadas e valem só para a próxima tecla, que sai como atalho.
 * Um dono só para a barra de ações, o painel de teclas, a digitação e a folha de atalhos: todos leem e gastam a mesma
 * escolha, e ela some ao trocar de conta (a escolha de uma pessoa nunca vale para a próxima).
 */
@Injectable({ providedIn: 'root' })
export class PcArmed {
  private readonly session = inject(SessionState);
  private readonly value = signal<ReadonlySet<PcModifier>>(new Set());

  /** As armadas agora. */
  readonly armed = this.value.asReadonly();

  constructor() {
    effect(() => {
      this.session.accountId();
      untracked(() => this.clear());
    });
  }

  has(modifier: PcModifier): boolean {
    return this.value().has(modifier);
  }

  toggle(modifier: PcModifier): void {
    const next = new Set(this.value());
    if (!next.delete(modifier)) next.add(modifier);
    this.value.set(next);
  }

  clear(): void {
    if (this.value().size > 0) this.value.set(new Set());
  }

  /** Junta o que está armado ao que o atalho já leva (na ordem fixa das teclas) e solta tudo: valem uma vez só. */
  take(base: readonly PcModifier[] = []): readonly PcModifier[] {
    const armed = this.value();
    if (armed.size === 0) return base;
    this.clear();
    return PC_MODIFIERS.filter((modifier) => armed.has(modifier) || base.includes(modifier));
  }
}
