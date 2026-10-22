import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AUTH_CONFIG, AuthService } from '../../../../core/auth/auth.service';
import { SessionState } from '../../../../core/session/session-state';
import type { PullPage } from './resource-sync';

/** A leitura não saiu porque o token em mãos não é o da conta dona do banco que vai recebê-la. */
export class SessionMismatchError extends Error {
  constructor() {
    super('A sessão deste navegador não é a da conta deste banco.');
    this.name = 'SessionMismatchError';
  }
}

/**
 * Leitura incremental genérica (`GET <caminho>?after=&limit=`). Usa o `HttpClient` do app (o interceptador de conexão vale), mas o
 * `Authorization` é montado aqui, com um token cujo `sub` é a conta que vai guardar a resposta: o interceptador de autenticação
 * só o deixa passar, em vez de renovar e repetir por baixo com o cookie que houver. Com o token de outra conta (outra pessoa
 * entrou noutra aba) a resposta seria dela, e entraria no banco local desta. Os testes trocam esta classe por uma falsa para
 * roteirizar as páginas sem depender de ordem de requisições.
 */
@Injectable({ providedIn: 'root' })
export class PullApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);
  private readonly minLeadMs = inject(AUTH_CONFIG).minLeadMs;

  async fetchPage<T>(
    path: string,
    after: string | null,
    limit: number,
    accountId: string,
  ): Promise<PullPage<T>> {
    let token = this.session.bearerOf(accountId, Date.now() + this.minLeadMs);
    if (token === null) {
      // Falta pouco (ou nada) do token: o `AuthService` renova, e só vale o token que ele deixou desta conta.
      await this.auth.accessToken();
      token = this.session.bearerOf(accountId);
    }
    if (token === null) throw new SessionMismatchError();

    let params = new HttpParams().set('limit', limit);
    if (after) params = params.set('after', after);
    const read = (bearer: string) =>
      firstValueFrom(
        this.http.get<PullPage<T>>(path, {
          params,
          headers: new HttpHeaders({ Authorization: `Bearer ${bearer}` }),
        }),
      );

    try {
      return await read(token);
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) throw error;
      await this.auth.renew();
      const renewed = this.session.bearerOf(accountId);
      if (renewed === null) throw new SessionMismatchError();
      return read(renewed);
    }
  }
}
