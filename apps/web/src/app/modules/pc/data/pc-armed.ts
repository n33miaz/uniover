import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { PC_MODIFIERS, type PcClickModifier, type PcModifier } from './pc-types';

/** Os modificadores que valem para o toque (`pc.click.v2`); o Windows fica armado, porque o clique não o leva. */
const CLICK_MODIFIERS: ReadonlySet<PcModifier> = new Set<PcClickModifier>(['CTRL', 'ALT', 'SHIFT']);

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

  /**
   * O que está armado e vale para um toque (Ctrl, Shift e Alt), na ordem fixa das teclas: some da barra, porque vale uma vez
   * só. O Windows, se armado, segue armado (o clique não o leva). Sem nada armado não muda nada.
   */
  takeForClick(): readonly PcClickModifier[] {
    const armed = this.value();
    const taken = PC_MODIFIERS.filter(
      (modifier): modifier is PcClickModifier =>
        armed.has(modifier) && CLICK_MODIFIERS.has(modifier),
    );
    if (taken.length === 0) return taken;
    const rest = new Set([...armed].filter((modifier) => !CLICK_MODIFIERS.has(modifier)));
    this.value.set(rest);
    return taken;
  }

  /** Junta o que está armado ao que o atalho já leva (na ordem fixa das teclas) e solta tudo: valem uma vez só. */
  take(base: readonly PcModifier[] = []): readonly PcModifier[] {
    const armed = this.value();
    if (armed.size === 0) return base;
    this.clear();
    return PC_MODIFIERS.filter((modifier) => armed.has(modifier) || base.includes(modifier));
  }
}
