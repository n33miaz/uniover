import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../core/api/generated/schema';
import { APP_CONFIG } from '../../core/config/app-config';
import { AuditPage, AuditPerson, AuditQuery, AuditSources } from './audit-model';

const BASE = `${APP_CONFIG.apiBase}/v1/identity`;

/** Quantos registros cada página traz: o que cabe em poucas telas do celular, nunca a trilha inteira. */
export const AUDIT_PAGE_SIZE = 25;

/** O arquivo da exportação e o que o servidor avisou sobre ele. */
export interface AuditExport {
  readonly blob: Blob;
  /** O servidor cortou: havia mais registros do que o teto da exportação (cabeçalho `X-Audit-Truncated`). */
  readonly truncated: boolean;
  /** O nome sugerido pelo servidor (`Content-Disposition`), quando veio. */
  readonly filename: string | null;
}

/** O nome do arquivo em `Content-Disposition: attachment; filename=...`, sem aspas; `null` se não veio. */
export function filenameFrom(disposition: string | null): string | null {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

/** Os filtros como a API os pede: `module` e `action` repetem a chave, e o que está vazio nem vai. */
export function paramsOf(
  query: AuditQuery,
  cursor: string | null,
  limit: number | null,
): HttpParams {
  let params = new HttpParams();
  if (query.person) params = params.set('person', query.person);
  for (const module of query.modules) params = params.append('module', module);
  for (const action of query.actions) params = params.append('action', action);
  if (query.outcome) params = params.set('outcome', query.outcome);
  if (query.from) params = params.set('from', query.from);
  if (cursor) params = params.set('cursor', cursor);
  if (limit !== null) params = params.set('limit', String(limit));
  return params;
}

/**
 * O que a tela Auditoria pede à API de identidade: a trilha paginada, as fontes (com o prazo de guarda de cada uma), a
 * exportação em CSV e a lista de pessoas para o filtro. Só o administrador chega a estas rotas (a API recusa o resto com
 * 403). Usa o `HttpClient`, cujos interceptadores levam o Bearer e renovam a sessão.
 *
 * Nada aqui escreve IP, aparelho ou o texto de um erro em log: o que a API devolve vai só para a tela.
 */
@Injectable({ providedIn: 'root' })
export class AuditApi {
  private readonly http = inject(HttpClient);

  sources(): Promise<AuditSources> {
    return firstValueFrom(this.http.get<AuditSources>(`${BASE}/audit/sources`));
  }

  /** Uma página, da mais nova para a mais velha; `cursor` é o `nextCursor` da página anterior. */
  list(query: AuditQuery, cursor: string | null = null): Promise<AuditPage> {
    return firstValueFrom(
      this.http.get<AuditPage>(`${BASE}/audit`, {
        params: paramsOf(query, cursor, AUDIT_PAGE_SIZE),
      }),
    );
  }

  /** O CSV da mesma consulta (sem página): o servidor limita as linhas e avisa se cortou. */
  async export(query: AuditQuery): Promise<AuditExport> {
    const response = await firstValueFrom(
      this.http.get(`${BASE}/audit/export`, {
        params: paramsOf(query, null, null),
        observe: 'response',
        responseType: 'blob',
      }),
    );
    return {
      blob: response.body ?? new Blob(),
      truncated: response.headers.get('X-Audit-Truncated') === 'true',
      filename: filenameFrom(response.headers.get('Content-Disposition')),
    };
  }

  /**
   * As contas que dá para escolher no filtro por pessoa: os convidados (a conta do administrador vem da sessão). Só id e
   * nome: o e-mail que a rota também devolve nunca sai daqui.
   */
  async guests(): Promise<readonly AuditPerson[]> {
    const guests = await firstValueFrom(
      this.http.get<components['schemas']['GuestSummary'][]>(`${BASE}/guests`),
    );
    return guests.map((guest) => ({ id: guest.id, name: guest.displayName }));
  }
}
