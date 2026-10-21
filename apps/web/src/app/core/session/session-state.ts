import { Injectable, computed, signal } from '@angular/core';
import { samePermissions, sameUser } from './user-equality';

/**
 * `unknown`: ainda não se sabe (início do app) · `anonymous`: sem sessão · `authenticated`: sessão renovada com
 * sucesso · `pending`: não deu para confirmar a sessão (sem rede, servidor dormindo); o app abre a casca assim
 * mesmo e nada local é apagado.
 */
export type SessionStatus = 'unknown' | 'anonymous' | 'authenticated' | 'pending';

/** Papel da conta: o dono (mostrado como "Administrador") usa tudo; o convidado usa o que as permissões dele liberam. */
export type AccountRole = 'owner' | 'guest';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** Ausente em respostas antigas: vale como dono (a API também trata assim um token sem papel). */
  readonly role?: string;
  /**
   * Falso enquanto a pessoa não escolheu o próprio nome (a tela de boas-vindas o pergunta). Ausente em respostas
   * antigas: vale como confirmado, para nunca prender ninguém numa pergunta que o servidor não faz.
   */
  readonly displayNameConfirmed?: boolean;
  /**
   * O que a conta pode usar, na ordem do catálogo da API (para o administrador, tudo). A tela a usa para explicar o que
   * a pessoa pode fazer e para não mostrar o que a API recusaria (`userCan`); quem decide de verdade é a API.
   */
  readonly permissions?: readonly string[];
}

/**
 * Dica do papel para a primeira tela quando a sessão ainda não foi confirmada (sem rede, servidor acordando): sem
 * ela o convidado veria por um instante a navegação do dono. Não é segredo e não decide acesso (quem decide é a API,
 * com 403): só evita mostrar o que o papel não alcança.
 */
const ROLE_HINT_KEY = 'uniover.account-role';

function readRoleHint(): AccountRole | null {
  try {
    const value = globalThis.localStorage?.getItem(ROLE_HINT_KEY);
    return value === 'owner' || value === 'guest' ? value : null;
  } catch {
    return null;
  }
}

function writeRoleHint(role: AccountRole | null): void {
  try {
    if (role) globalThis.localStorage?.setItem(ROLE_HINT_KEY, role);
    else globalThis.localStorage?.removeItem(ROLE_HINT_KEY);
  } catch {
    // Sem armazenamento (modo privado): a dica é só conforto.
  }
}

/**
 * Dica das permissões da última sessão, pelo mesmo motivo da dica do papel: sem rede (a academia) o usuário não chega, e
 * sem a lista quem só tem o Treino abriria o controle da TV ao entrar por `/`. Também só conforto: a API recusa o que a
 * conta não pode, com 403, e a lista de verdade (a de `/me`) substitui a dica assim que chega.
 */
const PERMISSIONS_HINT_KEY = 'uniover.account-permissions';

function readPermissionsHint(): readonly string[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(PERMISSIONS_HINT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

function writePermissionsHint(permissions: readonly string[] | null): void {
  try {
    if (permissions) {
      globalThis.localStorage?.setItem(PERMISSIONS_HINT_KEY, JSON.stringify(permissions));
    } else {
      globalThis.localStorage?.removeItem(PERMISSIONS_HINT_KEY);
    }
  } catch {
    // Sem armazenamento (modo privado): a dica é só conforto.
  }
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
  // Comparação por conteúdo: reler `/me` sem mudança de verdade não troca o valor, então nenhuma tela é refeita à toa.
  private readonly _user = signal<SessionUser | null>(null, { equal: sameUser });
  private readonly _expiresAt = signal<number | null>(null);
  private readonly _roleHint = signal<AccountRole | null>(readRoleHint());
  private readonly _permissionsHint = signal<readonly string[] | null>(readPermissionsHint());

  readonly status = this._status.asReadonly();
  readonly user = this._user.asReadonly();
  /** Instante (ms desde 1970) em que o token de acesso vence; não é o token. */
  readonly expiresAt = this._expiresAt.asReadonly();
  readonly isAuthenticated = computed(() => this._status() === 'authenticated');

  /** Papel conhecido: o do usuário carregado; sem ele, a dica da última sessão; `null` se não há nenhum dos dois. */
  readonly role = computed<AccountRole | null>(() => {
    const user = this._user();
    if (user) return user.role === 'guest' ? 'guest' : 'owner';
    return this._roleHint();
  });

  /** Só é verdadeiro quando se sabe que é convidado: papel desconhecido nunca tranca o dono para fora. */
  readonly isGuest = computed(() => this.role() === 'guest');

  /**
   * Só é verdadeiro quando o servidor disse, expressamente, que o nome ainda não foi escolhido (`false`): resposta sem o
   * campo, usuário ainda não carregado (sem rede) ou nome já confirmado nunca levam à tela de boas-vindas.
   */
  readonly needsWelcome = computed(() => this._user()?.displayNameConfirmed === false);

  /**
   * As permissões da conta carregada; vazio enquanto não se sabe (ou numa resposta antiga, sem a lista). Só troca de
   * valor quando o conjunto muda (a ordem e a lista nova da mesma resposta não contam): quem lê não refaz a tela à toa.
   */
  readonly permissions = computed<readonly string[]>(() => this._user()?.permissions ?? [], {
    equal: samePermissions,
  });

  /**
   * A lista de permissões, ou `null` se NÃO se sabe: usuário ainda não carregado e sem dica da última sessão, ou resposta
   * antiga sem a lista. Diferente de `permissions`, que mistura "vazio" com "não sei": quem decide para onde levar a pessoa
   * precisa separar os dois, para nunca mandá-la a "sem acesso" só porque a rede falhou.
   */
  readonly knownPermissions = computed<readonly string[] | null>(() => {
    const user = this._user();
    return user ? (user.permissions ?? null) : this._permissionsHint();
  });

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

  /** Guarda a conta lida. Devolve se ela mudou de verdade (comparação por conteúdo): igual não avisa ninguém. */
  setUser(user: SessionUser): boolean {
    const changed = !sameUser(this._user(), user);
    this._user.set(user);
    const role: AccountRole = user.role === 'guest' ? 'guest' : 'owner';
    this._roleHint.set(role);
    writeRoleHint(role);
    const permissions = user.permissions ?? null;
    this._permissionsHint.set(permissions);
    writePermissionsHint(permissions);
    return changed;
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
    this._roleHint.set(null);
    writeRoleHint(null);
    this._permissionsHint.set(null);
    writePermissionsHint(null);
    this._status.set(status);
  }
}
