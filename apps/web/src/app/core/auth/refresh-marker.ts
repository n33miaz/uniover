import { InjectionToken } from '@angular/core';

/**
 * Marca "uma renovação começou e ainda não sei como terminou". Fica no `localStorage` (sobrevive à página que o iPhone
 * descarta e vale para todas as abas): quem encontra a marca não repete o refresh comum com o cookie que pode já ter
 * girado, e sim a recuperação (desafio, prova, refresh). Só 200 e 401 a apagam, quando o servidor disse de vez como a
 * sessão ficou. Não guarda segredo nenhum.
 */
export interface RefreshMarker {
  isSet(): boolean;
  set(): void;
  clear(): void;
}

const KEY = 'uniover.refresh-in-flight';

export const REFRESH_MARKER = new InjectionToken<RefreshMarker>('REFRESH_MARKER', {
  providedIn: 'root',
  factory: () => new StorageRefreshMarker(),
});

export class StorageRefreshMarker implements RefreshMarker {
  // Sem armazenamento (modo privado, bloqueado) a marca vive só na memória da página: vale enquanto ela existir.
  private memory = false;

  isSet(): boolean {
    try {
      return globalThis.localStorage.getItem(KEY) !== null || this.memory;
    } catch {
      return this.memory;
    }
  }

  set(): void {
    this.memory = true;
    try {
      globalThis.localStorage.setItem(KEY, '1');
    } catch {
      // sem armazenamento: fica na memória
    }
  }

  clear(): void {
    this.memory = false;
    try {
      globalThis.localStorage.removeItem(KEY);
    } catch {
      // nada a limpar
    }
  }
}
