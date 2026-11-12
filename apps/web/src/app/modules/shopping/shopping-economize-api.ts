import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../core/config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/shopping`;

export interface EconomizeFree {
  readonly salaryKnown: boolean;
  readonly salaryDate: string | null;
  readonly daysUntilSalary: number | null;
  readonly expectedSalaryCents: number | null;
  readonly committedBeforeSalaryCents: number | null;
  readonly committedAfterSalaryCents: number | null;
  readonly freeCents: number | null;
}

/** O conselho do Economize para a ida ao mercado. Sem `available`, `reason` diz por quê. */
export interface EconomizeAdvice {
  readonly available: boolean;
  readonly reason: 'disabled' | 'waking' | 'unauthorized' | 'unavailable' | null;
  readonly generatedAt: string | null;
  readonly status: string | null;
  readonly bestDay: string | null;
  readonly bestDayWeekday: string | null;
  readonly free: EconomizeFree | null;
}

/** Em que pé está a importação das compras do Economize (a busca de lá ou o arquivo). */
export interface EconomizeImport {
  readonly running: boolean;
  readonly finished: boolean;
  readonly imported: number;
  readonly existing: number;
  readonly ignored: number;
  readonly error: 'disabled' | 'unauthorized' | 'unavailable' | 'membership_changed' | null;
}

/**
 * A ponte com o Economize, só para o administrador (a API responde 403 aos demais, e a tela então não mostra nada):
 * o conselho do dia (livre até o salário, melhor dia para comprar) e a importação do histórico de compras.
 */
@Injectable({ providedIn: 'root' })
export class ShoppingEconomizeApi {
  private readonly http = inject(HttpClient);

  advice(): Promise<EconomizeAdvice> {
    return firstValueFrom(this.http.get<EconomizeAdvice>(`${BASE}/advice`));
  }

  /** Começa a buscar no Economize (202, sem corpo); o andamento vem por `importState`. */
  startImport(): Promise<unknown> {
    return firstValueFrom(this.http.post(`${BASE}/import/economize`, null));
  }

  importState(): Promise<EconomizeImport> {
    return firstValueFrom(this.http.get<EconomizeImport>(`${BASE}/import/economize`));
  }

  /** O `.json` exportado do Economize (`{ trips: [...] }`, até 2 MB). */
  importFile(file: unknown): Promise<EconomizeImport> {
    return firstValueFrom(this.http.post<EconomizeImport>(`${BASE}/import/economize/file`, file));
  }
}
