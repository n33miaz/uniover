import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { PcAvailability } from '../../core/modules/pc-availability';
import { SessionState } from '../../core/session/session-state';

/**
 * Onde o aparelho lembra, por conta, só isto: a última leitura disse que há um computador com o controle do PC ligado
 * (`yes`) ou que não há (`no`). Nada do computador em si (nem favoritos, nem volume, nem se está conectado).
 */
const MEMORY_PREFIX = 'uniover.home.pc.v1.';

type Remembered = 'yes' | 'no';

/**
 * O que a Início sabe sobre o cartão do Controle do PC antes de a API responder. Sem isto o cartão nascia como "Em Breve"
 * (nada sabido = planejado) e, ao chegar a resposta, virava o cartão de verdade: o piscar de "desativado" a cada abertura.
 *
 * A pergunta tem três respostas: `true`, `false` e `null` (a leitura está em andamento e nada se lembra). Só a API ou a
 * lembrança desta conta dizem `true`; enquanto for `null` a Início não desenha o cartão (nem como ativo nem como
 * planejado), então nada muda de aparência quando a resposta chega. Se a leitura termina sem resposta (rede, sessão) e nada
 * se lembra, vale `false`: nunca se afirma um computador que ninguém confirmou. A lembrança é por conta, descartada quando
 * a conta perde a permissão do PC, e nunca vale mais que a leitura da API (que a corrige a cada visita).
 */
@Injectable({ providedIn: 'root' })
export class HomePcCard {
  private readonly availability = inject(PcAvailability);
  private readonly session = inject(SessionState);
  private readonly doc = inject(DOCUMENT);
  private readonly storage = this.openStorage();

  private readonly remembered = linkedSignal<string | null, boolean | null>({
    source: () => this.session.accountId(),
    computation: (accountId) => this.read(accountId),
  });

  /** A primeira leitura desta conta terminou (com ou sem resposta): daí em diante a falta de resposta já não é "espere". */
  private readonly settled = linkedSignal<string | null, boolean>({
    source: () => this.session.accountId(),
    computation: () => false,
  });

  /** Há um computador com o controle ligado? `null` enquanto a leitura corre e nem a lembrança desta conta responde. */
  readonly available = computed<boolean | null>(() => {
    const status = this.availability.status();
    if (status) return status.available;
    return this.remembered() ?? (this.settled() ? false : null);
  });

  /**
   * Relê o estado na API e lembra a resposta. Uma resposta que falha deixa a lembrança como estava (e, sem ela, o cartão fica
   * como "em breve": nunca se inventa um computador).
   */
  async refresh(): Promise<void> {
    const asked = this.session.accountId();
    const answered = await this.availability.refresh();
    if (this.session.accountId() !== asked) return;
    this.settled.set(true);
    const status = this.availability.status();
    if (!answered || !status || asked === null) return;
    this.remembered.set(status.available);
    this.write(asked, status.available ? 'yes' : 'no');
  }

  /** A conta não pode usar o PC: a lembrança de uma permissão que já não existe não vale. */
  forget(): void {
    const account = this.session.accountId();
    this.remembered.set(null);
    if (account === null) return;
    try {
      this.storage?.removeItem(MEMORY_PREFIX + encodeURIComponent(account));
    } catch {
      // Armazenamento bloqueado: nada a apagar.
    }
  }

  private read(accountId: string | null): boolean | null {
    if (accountId === null) return null;
    try {
      const value = this.storage?.getItem(MEMORY_PREFIX + encodeURIComponent(accountId));
      return value === 'yes' ? true : value === 'no' ? false : null;
    } catch {
      return null;
    }
  }

  private write(accountId: string, value: Remembered): void {
    try {
      this.storage?.setItem(MEMORY_PREFIX + encodeURIComponent(accountId), value);
    } catch {
      // Sem espaço ou bloqueado: sem lembrança, o cartão só espera a API como na primeira visita.
    }
  }

  private openStorage(): Storage | null {
    try {
      return this.doc.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }
}
