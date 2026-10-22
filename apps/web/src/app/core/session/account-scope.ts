import { Injectable, Signal, computed, inject } from '@angular/core';
import { isLegacyAdoptionDone, markLegacyAdoptionDone, readLegacyOwner } from './account-id';
import { SessionState } from './session-state';

/**
 * A conta dos dados locais em uso, como os serviços a enxergam. Duas perguntas diferentes, de propósito:
 * - **qual banco abrir** (`id`): a conta confirmada por `/me` ou, enquanto ela não chega (sem rede, servidor acordando),
 *   a dica da última sessão. Serve só para ler e gravar no aparelho;
 * - **a sessão em mãos é desta conta?** (`isSessionOf`): só `/me` responde. É o que decide enviar algo ao servidor, porque
 *   um token de outra conta gravaria no usuário errado.
 *
 * É uma porta: o teste troca por uma conta fixa (ou por uma que ele mesmo muda), sem passar pela sessão nem pelo
 * `localStorage`, que os arquivos de teste dividem.
 */
@Injectable({ providedIn: 'root' })
export class AccountScope {
  private readonly session = inject(SessionState);

  /** A conta cujo banco local se usa, ou `null` se não se sabe (nenhum banco deve estar aberto). */
  readonly id: Signal<string | null> = this.session.accountId;

  /**
   * A conta a quem a sessão em memória pertence, como o `/me` a confirmou (`null` até ele responder). Muda quando o `/me`
   * chega: é o gatilho para tentar de novo o que esperava por uma sessão de conta conhecida.
   */
  readonly sessionAccount = computed<string | null>(() => this.session.user()?.id ?? null);

  /** O token em memória é desta conta, e nenhuma outra aba trocou de conta desde? */
  isSessionOf(accountId: string): boolean {
    return this.session.isSessionOf(accountId);
  }

  /** Esta conta é a que adota os bancos antigos (a primeira confirmada neste aparelho)? */
  isLegacyOwner(accountId: string): boolean {
    return readLegacyOwner() === accountId;
  }

  /** Falta esta conta adotar o banco antigo `legacyName`: ela é a dona e a adoção ainda não terminou? */
  shouldAdopt(legacyName: string, accountId: string): boolean {
    return this.isLegacyOwner(accountId) && !isLegacyAdoptionDone(legacyName, accountId);
  }

  /** A adoção do banco antigo terminou (ou não há o que adotar): nos próximos começos nem se confere. */
  adoptionFinished(legacyName: string, accountId: string): void {
    markLegacyAdoptionDone(legacyName, accountId);
  }
}
