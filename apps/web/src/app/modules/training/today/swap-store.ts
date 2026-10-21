import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

/** Chave do aparelho onde ficam as trocas de exercício do treino aberto. */
export const SWAPS_KEY = 'uniover.training.swaps.v1';

interface Stored {
  readonly sessionId: string;
  readonly swaps: Readonly<Record<string, string>>;
}

/**
 * As trocas de exercício "só por hoje" do treino aberto: o item da rotina e o exercício que o substitui. Ficam no
 * aparelho, presas ao id do treino, para recarregar a página no meio do treino não desfazer a troca.
 *
 * Guardar no aparelho é um remendo honesto: o lugar certo seria o banco local do treino (como o pulo de exercício), mas
 * essa camada não é desta tela. Só vale para o treino aberto: ao encerrar ou cancelar, a tela chama `clear`; uma troca de
 * outro treino nunca é lida. Sem armazenamento do navegador (janela privada), a troca vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class SwapStore {
  private readonly storage = storageOf(inject(DOCUMENT).defaultView);
  private memory: Stored | null = null;

  /** As trocas do treino `sessionId` (item → exercício substituto); vazio quando não há. */
  read(sessionId: string): Map<string, string> {
    const stored = this.load();
    if (stored === null || stored.sessionId !== sessionId) return new Map();
    return new Map(Object.entries(stored.swaps));
  }

  write(sessionId: string, swaps: ReadonlyMap<string, string>): void {
    const stored: Stored = { sessionId, swaps: Object.fromEntries(swaps) };
    this.memory = stored;
    try {
      this.storage?.setItem(SWAPS_KEY, JSON.stringify(stored));
    } catch {
      // Sem espaço ou sem permissão: a troca vale na memória até recarregar.
    }
  }

  clear(): void {
    this.memory = null;
    try {
      this.storage?.removeItem(SWAPS_KEY);
    } catch {
      // Nada a limpar.
    }
  }

  private load(): Stored | null {
    try {
      const raw = this.storage?.getItem(SWAPS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Stored>;
        if (typeof parsed.sessionId === 'string' && typeof parsed.swaps === 'object') {
          return { sessionId: parsed.sessionId, swaps: parsed.swaps as Record<string, string> };
        }
      }
    } catch {
      // Texto estragado ou armazenamento bloqueado: vale o que está na memória.
    }
    return this.memory;
  }
}

function storageOf(win: Window | null): Storage | null {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}
