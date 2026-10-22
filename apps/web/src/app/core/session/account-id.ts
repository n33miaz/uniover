/**
 * Identidade de conta para nomear o que fica no aparelho. O navegador é um só, mas as contas são várias (o dono
 * testando como convidado, um aparelho emprestado): cada conta tem o próprio banco local e a própria fila de escrita.
 * Este arquivo não depende de nada (a sessão o usa, e o resto do app também).
 */

/** Só caracteres que cabem num nome de banco e numa chave: o id da API é um UUID; o simulador usa ids curtos. */
const ACCOUNT_ID = /^[A-Za-z0-9-]{1,64}$/;

export function isValidAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

/**
 * Nome do banco de uma conta: `<base>-<id>`. O id já é seguro (ver `isValidAccountId`), mas o nome nunca sai de um id sem
 * validar: um id estranho viraria um banco com nome estranho, ou colidiria com o de outra conta.
 */
export function accountDatabaseName(base: string, accountId: string): string {
  if (!isValidAccountId(accountId)) {
    throw new TypeError('Id de conta inválido para nome de banco.');
  }
  return `${base}-${accountId}`;
}

/**
 * Quem pode adotar os bancos antigos (os que existiam antes de haver um por conta). É a PRIMEIRA conta DO DONO confirmada
 * neste aparelho depois da atualização (o convidado nunca adota: antes das contas as rotas do Treino eram só do dono, então
 * todo banco antigo é dele); ela fica registrada aqui para valer também quando a adoção de cada banco acontece em
 * momentos diferentes (a fila na partida, o Treino na primeira vez que a pessoa o abre). Uma segunda conta que entre
 * antes disso começa vazia, e os dados do primeiro dono nunca vão parar nela.
 */
export const LEGACY_OWNER_KEY = 'uniover.legacy-owner';

export function readLegacyOwner(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(LEGACY_OWNER_KEY);
    return isValidAccountId(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Registra a conta como dona dos bancos antigos se ainda não há dona. Nunca troca a dona. Devolve a dona depois da tentativa
 * (`null` se ninguém é dona, por exemplo sem armazenamento).
 */
export function claimLegacyOwner(accountId: string): string | null {
  try {
    const current = readLegacyOwner();
    if (current !== null || !isValidAccountId(accountId)) return current;
    globalThis.localStorage?.setItem(LEGACY_OWNER_KEY, accountId);
    return readLegacyOwner();
  } catch {
    // Sem armazenamento (modo privado): sem dona registrada, nenhuma conta adota (e nada se perde nem se mistura).
    return null;
  }
}

/**
 * Memória de que a adoção de um banco antigo já terminou para uma conta. Sem ela, todo começo do app da conta dona abriria
 * (e, não havendo banco antigo, criaria e apagaria) o banco antigo à toa, e a tela esperaria por isso. Perder esta memória
 * só custa repetir a conferência, que é segura.
 */
const LEGACY_DONE_PREFIX = 'uniover.legacy-adopted.';

export function isLegacyAdoptionDone(legacyName: string, accountId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(LEGACY_DONE_PREFIX + legacyName) === accountId;
  } catch {
    return false;
  }
}

export function markLegacyAdoptionDone(legacyName: string, accountId: string): void {
  try {
    if (isValidAccountId(accountId)) {
      globalThis.localStorage?.setItem(LEGACY_DONE_PREFIX + legacyName, accountId);
    }
  } catch {
    // Sem armazenamento: a conferência se repete no próximo começo, sem prejuízo.
  }
}
