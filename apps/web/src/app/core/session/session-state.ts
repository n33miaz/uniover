import { Injectable, computed, signal } from '@angular/core';

/**
 * `unknown`: ainda não se sabe (início do app) · `anonymous`: sem sessão · `authenticated`: sessão renovada com
 * sucesso · `pending`: não deu para confirmar a sessão (sem rede, servidor dormindo); o app abre a casca assim
 * mesmo e nada local é apagado.
 */
export type SessionStatus = 'unknown' | 'anonymous' | 'authenticated' | 'pending';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Estado da sessão em memória. O token de acesso vive num campo privado: não é signal, não é serializado e
 * não passa por nenhum armazenamento do navegador (`localStorage`, `sessionStorage`, IndexedDB). Recarregar a
 * página o perde de propósito; o refresh silencioso pelo cookie `HttpOnly` o devolve.
 */
@Injectable({ providedIn: 'root' })
export class SessionState {
  /** Só este campo guarda o token. Nunca expor em signal, log ou objeto serializável. */
  #accessToken: string | null = null;

  private readonly _status = signal<SessionStatus>('unknown');
  private readonly _user = signal<SessionUser | null>(null);
  private readonly _expiresAt = signal<number | null>(null);

  readonly status = this._status.asReadonly();
  readonly user = this._user.asReadonly();
  /** Instante (ms desde 1970) em que o token de acesso vence; não é o token. */
  readonly expiresAt = this._expiresAt.asReadonly();
  readonly isAuthenticated = computed(() => this._status() === 'authenticated');

  /** Token para o cabeçalho `Authorization`, ou `null` se não houver um ainda utilizável. */
  bearer(nowMs: number = Date.now()): string | null {
    const expiresAt = this._expiresAt();
    if (this.#accessToken === null || expiresAt === null || expiresAt <= nowMs) return null;
    return this.#accessToken;
  }

  /** Há token em memória, mesmo que já vencido (decide se vale tentar renovar). */
  hasToken(): boolean {
    return this.#accessToken !== null;
  }

  setToken(token: string, expiresInSeconds: number, nowMs: number = Date.now()): void {
    this.#accessToken = token;
    this._expiresAt.set(nowMs + expiresInSeconds * 1000);
    this._status.set('authenticated');
  }

  setUser(user: SessionUser): void {
    this._user.set(user);
  }

  /** Sessão não confirmada: mantém usuário e token vencido de lado, sem apagar nada do aparelho. */
  setPending(): void {
    if (this._status() !== 'authenticated' || this.bearer() === null) this._status.set('pending');
  }

  /** Esquece token e usuário da memória. Não toca em IndexedDB nem em filas locais. */
  clear(status: 'anonymous' | 'unknown' = 'anonymous'): void {
    this.#accessToken = null;
    this._expiresAt.set(null);
    this._user.set(null);
    this._status.set(status);
  }
}
