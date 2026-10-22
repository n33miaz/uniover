import { Injectable, computed, signal } from '@angular/core';
import { claimLegacyOwner, isValidAccountId, readLegacyOwner } from './account-id';
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
 * A conta a quem um token de acesso pertence: o `sub` do payload (a API o emite igual ao id do usuário). Só LEITURA do
 * payload, sem validar a assinatura (quem valida é a API): serve para o app saber de quem é o token que tem na mão e nunca
 * mandar uma escrita de uma conta com o token de outra. `null` se o token não tem `sub` legível.
 */
function subjectOf(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const subject = (JSON.parse(json) as { sub?: unknown }).sub;
    return isValidAccountId(subject) ? subject : null;
  } catch {
    return null;
  }
}

/**
 * Dica da conta da última sessão (o id), pelo mesmo motivo das outras: o Treino abre sem rede, antes de o `/me` responder, e
 * precisa saber QUAL banco local abrir (cada conta tem o seu). Só escolhe o banco para ler e gravar no aparelho: nada é
 * enviado ao servidor por causa dela (a conta da sessão só se confirma pelo `/me`, ver `isSessionOf`). Some ao sair; sem ela
 * (e sem `/me`) nenhum banco de conta é aberto.
 */
const ACCOUNT_HINT_KEY = 'uniover.account-id';

function readAccountHint(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(ACCOUNT_HINT_KEY);
    return isValidAccountId(value) ? value : null;
  } catch {
    return null;
  }
}

/** `true` se a dica ficou gravada (ou foi apagada); `false` se o aparelho não deixou guardar nada. */
function writeAccountHint(accountId: string | null): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    if (accountId) storage.setItem(ACCOUNT_HINT_KEY, accountId);
    else storage.removeItem(ACCOUNT_HINT_KEY);
    return true;
  } catch {
    return false;
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
  private readonly _accountHint = signal<string | null>(readAccountHint());
  /** A conta a quem o token em memória pertence (o `sub` dele); `null` sem token ou com token sem `sub` legível. */
  private readonly _tokenAccount = signal<string | null>(null);
  /** A dona dos bancos antigos (a primeira conta do dono confirmada neste aparelho); `null` enquanto ninguém o foi. */
  private readonly _legacyOwner = signal<string | null>(readLegacyOwner());
  /** A dica da conta está mesmo gravada neste aparelho (sem isso não há como saber se outra aba trocou de conta). */
  #accountHintStored = this._accountHint() !== null;

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

  /**
   * A conta cujos dados locais valem: a do usuário carregado (`/me`); sem ele, a dica da última sessão; `null` se não há
   * nenhum dos dois. Escolhe o banco local (um por conta), nunca autoriza enviar nada (ver `isSessionOf`).
   */
  readonly accountId = computed<string | null>(() => {
    const user = this._user();
    if (user) return isValidAccountId(user.id) ? user.id : null;
    return this._accountHint();
  });

  /**
   * A conta a quem a sessão em memória pertence: a do `sub` do token (que já vale antes do `/me`) ou, sem `sub` legível, a
   * do `/me`. Muda quando o token ou a conta carregada mudam: é o gatilho para tentar de novo o que esperava por uma sessão
   * de conta conhecida.
   */
  readonly sessionAccountId = computed<string | null>(
    () => this._tokenAccount() ?? this._user()?.id ?? null,
  );

  /**
   * Já dá para decidir quem adota os bancos antigos? Sim quando alguém já é dona, ou quando a conta carregada (e portanto o
   * papel dela) já é conhecida. Antes disso (token válido mas `/me` ainda por vir) não se sabe se a conta é a do dono, e a
   * adoção espera: abrir o banco da conta sem adotar deixaria o Treino do dono vazio até a próxima partida.
   */
  readonly legacyDecided = computed(() => this._legacyOwner() !== null || this._user() !== null);

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

  /**
   * O token em memória é desta conta? Quem responde é o `sub` do token (de quem ele é de verdade) e o `/me` carregado: os
   * dois que existirem têm de dizer esta conta, e ao menos um tem de existir (a dica não basta: com o cookie de refresh de
   * outra conta, o token novo seria dela). Com o `sub` legível um `/me` que falhou não impede nada: o token já diz de quem
   * é. Também deixa de valer se outra aba do navegador entrou noutra conta: o cookie de refresh é um só para todas as abas,
   * então esta aba já pode estar renovando com o token da outra conta sem saber, e é isto que impede a fila de uma conta de
   * sair com o token de outra.
   */
  isSessionOf(accountId: string): boolean {
    const subject = this._tokenAccount();
    const userId = this._user()?.id ?? null;
    if (subject !== null && subject !== accountId) return false;
    if (userId !== null && userId !== accountId) return false;
    if (subject === null && userId === null) return false;
    if (!this.#accountHintStored) return true;
    try {
      return globalThis.localStorage?.getItem(ACCOUNT_HINT_KEY) === accountId;
    } catch {
      return true;
    }
  }

  /** Token para o cabeçalho `Authorization`, ou `null` se não houver um ainda utilizável. */
  bearer(nowMs: number = Date.now()): string | null {
    const expiresAt = this._expiresAt();
    if (this.#accessToken === null || expiresAt === null || expiresAt <= nowMs) return null;
    return this.#accessToken;
  }

  /**
   * O token de acesso, SÓ se ele é desta conta (pelo `sub`) e ainda vale. É o que a fila e a leitura incremental põem no
   * `Authorization` por conta própria: um token de outra conta nunca sai daqui, qualquer que seja o cookie do navegador.
   * Token sem `sub` legível não vale para esta operação: uma escrita não pode depender da dica ou de um `/me` antigo.
   */
  bearerOf(accountId: string, nowMs: number = Date.now()): string | null {
    const token = this.bearer(nowMs);
    if (token === null) return null;
    const subject = this._tokenAccount();
    if (subject !== accountId) return null;
    const userId = this._user()?.id;
    return userId === undefined || userId === accountId ? token : null;
  }

  /** Há token em memória, mesmo que já vencido (decide se vale tentar renovar). */
  hasToken(): boolean {
    return this.#accessToken !== null;
  }

  setToken(token: string, expiresInSeconds: number, nowMs: number = Date.now()): void {
    this.#accessToken = token;
    const subject = subjectOf(token);
    this._tokenAccount.set(subject);
    this._expiresAt.set(nowMs + expiresInSeconds * 1000);
    this._status.set('authenticated');
    // A conta já é conhecida pelo token, antes de o `/me` voltar: a dica é gravada agora, então o próximo começo sem rede (e
    // o primeiro depois desta atualização, que nunca a gravou) já sabe qual banco abrir.
    if (subject !== null) this.rememberAccount(subject);
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
    const accountId = isValidAccountId(user.id) ? user.id : null;
    if (accountId) this.rememberAccount(accountId);
    else this.forgetAccountHint();
    // A primeira conta DO DONO confirmada neste aparelho é a que adota os bancos de antes das contas (ver `account-id.ts`):
    // o convidado nunca adota, entre primeiro ou não.
    if (accountId && user.role !== 'guest') this._legacyOwner.set(claimLegacyOwner(accountId));
    else this._legacyOwner.set(readLegacyOwner());
    return changed;
  }

  private rememberAccount(accountId: string): void {
    this._accountHint.set(accountId);
    this.#accountHintStored = writeAccountHint(accountId);
  }

  private forgetAccountHint(): void {
    this._accountHint.set(null);
    this.#accountHintStored = false;
    writeAccountHint(null);
  }

  /** Sessão não confirmada: mantém usuário e token vencido de lado, sem apagar nada do aparelho. */
  setPending(): void {
    if (this._status() !== 'authenticated' || this.bearer() === null) this._status.set('pending');
  }

  /** Esquece token e usuário da memória (e a dica da conta). Não toca em IndexedDB nem em filas locais. */
  clear(status: 'anonymous' | 'unknown' = 'anonymous'): void {
    this.#accessToken = null;
    this._tokenAccount.set(null);
    this._expiresAt.set(null);
    this._user.set(null);
    this._roleHint.set(null);
    writeRoleHint(null);
    this._permissionsHint.set(null);
    writePermissionsHint(null);
    this._accountHint.set(null);
    writeAccountHint(null);
    this.#accountHintStored = false;
    this._status.set(status);
  }
}
