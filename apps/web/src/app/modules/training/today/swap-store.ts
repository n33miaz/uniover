import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { AccountScope } from '../../../core/session/account-scope';

/**
 * Chave do tempo em que havia uma só por aparelho. Hoje só é lida para a adoção (a dona dos bancos antigos leva as trocas
 * que estavam nela); cada conta usa a sua (`swapsKey`).
 */
export const SWAPS_KEY = 'uniover.training.swaps.v1';

/** Chave do aparelho onde ficam as trocas de exercício do treino aberto de UMA conta. */
export function swapsKey(accountId: string): string {
  return `${SWAPS_KEY}.${accountId}`;
}

interface Stored {
  readonly sessionId: string;
  readonly swaps: Readonly<Record<string, string>>;
}

/**
 * As trocas de exercício "só por hoje" do treino aberto: o item da rotina e o exercício que o substitui. Ficam no
 * aparelho, presas à conta e ao id do treino, para recarregar a página no meio do treino não desfazer a troca (e para o
 * treino aberto de uma pessoa nunca ser lido nem apagado por outra que use o mesmo navegador). Sem conta conhecida não
 * guarda nem lê nada.
 *
 * Guardar no aparelho é um remendo honesto: o lugar certo seria o banco local do treino (como o pulo de exercício), mas
 * essa camada não é desta tela. Só vale para o treino aberto: ao encerrar ou cancelar, a tela chama `clear`; uma troca de
 * outro treino nunca é lida. Sem armazenamento do navegador (janela privada), a troca vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class SwapStore {
  private readonly storage = storageOf(inject(DOCUMENT).defaultView);
  private readonly account = inject(AccountScope);
  /** Na memória, por conta: vale quando o armazenamento do navegador não deixa guardar. */
  private readonly memory = new Map<string, Stored>();

  /** As trocas do treino `sessionId` (item → exercício substituto); vazio quando não há. */
  read(sessionId: string): Map<string, string> {
    const accountId = this.account.id();
    if (accountId === null) return new Map();
    const stored = this.load(accountId);
    if (stored === null || stored.sessionId !== sessionId) return new Map();
    return new Map(Object.entries(stored.swaps));
  }

  write(sessionId: string, swaps: ReadonlyMap<string, string>): void {
    const accountId = this.account.id();
    if (accountId === null) return;
    const stored: Stored = { sessionId, swaps: Object.fromEntries(swaps) };
    this.memory.set(accountId, stored);
    try {
      this.storage?.setItem(swapsKey(accountId), JSON.stringify(stored));
    } catch {
      // Sem espaço ou sem permissão: a troca vale na memória até recarregar.
    }
  }

  clear(): void {
    const accountId = this.account.id();
    if (accountId === null) return;
    this.memory.delete(accountId);
    try {
      this.storage?.removeItem(swapsKey(accountId));
    } catch {
      // Nada a limpar.
    }
  }

  private load(accountId: string): Stored | null {
    try {
      const raw = this.storage?.getItem(swapsKey(accountId)) ?? this.adoptOld(accountId);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Stored>;
        if (typeof parsed.sessionId === 'string' && typeof parsed.swaps === 'object') {
          return { sessionId: parsed.sessionId, swaps: parsed.swaps as Record<string, string> };
        }
      }
    } catch {
      // Texto estragado ou armazenamento bloqueado: vale o que está na memória.
    }
    return this.memory.get(accountId) ?? null;
  }

  /**
   * As trocas gravadas no tempo da chave única são da conta que adota os bancos antigos: ela as leva para a chave dela
   * (uma vez) e a antiga some. Qualquer outra conta nunca as vê.
   */
  private adoptOld(accountId: string): string | null {
    if (!this.account.isLegacyOwner(accountId)) return null;
    const raw = this.storage?.getItem(SWAPS_KEY) ?? null;
    if (raw === null) return null;
    this.storage?.setItem(swapsKey(accountId), raw);
    this.storage?.removeItem(SWAPS_KEY);
    return raw;
  }
}

function storageOf(win: Window | null): Storage | null {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}
