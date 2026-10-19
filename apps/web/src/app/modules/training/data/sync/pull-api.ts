import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { PullPage } from './resource-sync';

/**
 * Leitura incremental genérica (`GET <caminho>?after=&limit=`). Usa o `HttpClient` do app, então os
 * interceptadores de conexão e de autenticação valem. Os testes trocam esta classe por uma falsa para roteirizar
 * as páginas sem depender de ordem de requisições.
 */
@Injectable({ providedIn: 'root' })
export class PullApi {
  private readonly http = inject(HttpClient);

  fetchPage<T>(path: string, after: string | null, limit: number): Promise<PullPage<T>> {
    let params = new HttpParams().set('limit', limit);
    if (after) params = params.set('after', after);
    return firstValueFrom(this.http.get<PullPage<T>>(path, { params }));
  }
}
