import { InjectionToken } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type { AccountScope } from './account-scope';

/**
 * Como abrir um banco antigo (do tempo em que havia um só por aparelho). Sem esquema declarado: o Dexie lê o que o banco
 * tem. É uma porta para o teste abrir o banco antigo na fábrica falsa do IndexedDB.
 */
export const LEGACY_DB_OPENER = new InjectionToken<(name: string) => Dexie>('LEGACY_DB_OPENER', {
  providedIn: 'root',
  factory: () => (name) => new Dexie(name),
});

/**
 * `none`: não há banco antigo · `taken`: ele já é de outra conta · `already`: já foi adotado por esta conta · `adopted`:
 * copiado e conferido agora · `failed`: algo deu errado e NADA foi marcado (a próxima partida recomeça, sem duplicar).
 */
export type AdoptionOutcome = 'none' | 'taken' | 'already' | 'adopted' | 'failed';

export interface LegacyAdoption {
  /** Nome do banco antigo (`uniover-training`, `uniover-offline`). */
  readonly legacyName: string;
  /** A conta que adota. Quem chama já decidiu que ela é a dona (a primeira conta confirmada do aparelho). */
  readonly accountId: string;
  /** O banco da conta, já aberto com o esquema novo. */
  readonly target: Dexie;
  /** As tabelas a copiar (o banco antigo e o novo têm as mesmas). */
  readonly tables: readonly string[];
  readonly openLegacy: (name: string) => Dexie;
}

/** Marcas que a adoção grava na tabela `meta` do banco ANTIGO (nunca são copiadas para o novo). */
const CLAIM_KEY = 'adoption:claimedBy';
const DONE_KEY = 'adoption:doneAt';
const CHUNK = 400;
const LOCK_WAIT_MS = 10_000;

/**
 * A conta dona adota os bancos antigos: copia as linhas para o banco dela, CONFERE que toda chave do antigo está no novo e só
 * então marca o antigo como adotado. O antigo não é apagado (é a cópia de segurança; apagar fica para quando houver certeza).
 *
 * Seguro para recomeçar e para duas abas ao mesmo tempo:
 * - a conta reivindica o banco antigo ANTES de copiar (na própria tabela `meta` dele): uma execução interrompida nunca deixa
 *   outra conta adotar o resto;
 * - copiar é "grava se ainda não existe": rodar de novo não duplica, e uma linha que a conta já mexeu no banco novo não é
 *   sobrescrita pela versão velha;
 * - uma aba por vez (`navigator.locks`), e a segunda encontra a adoção pronta.
 * - se outra aba não liberar o bloqueio em 10 segundos, desiste sem reivindicar nem copiar; a próxima partida tenta de novo.
 *
 * Nunca rejeita: devolve `failed` e o app segue com o banco da conta (a adoção recomeça na próxima partida).
 */
export async function adoptLegacyDatabase(options: LegacyAdoption): Promise<AdoptionOutcome> {
  try {
    return await exclusive(`uniover-adopt:${options.legacyName}`, () => run(options));
  } catch {
    return 'failed';
  }
}

/**
 * Adota o banco antigo SE for a vez desta conta: devolve `null` quando não há nada a fazer (a conta não é a dona, ou a
 * adoção já terminou num começo anterior), e quem chama não espera por nada. Quando termina (copiada, já adotada, sem banco
 * antigo), anota isso para os próximos começos não repetirem a conferência; uma falha não anota, e a próxima partida tenta
 * de novo.
 */
export function adoptWhenDue(
  scope: Pick<AccountScope, 'shouldAdopt' | 'adoptionFinished'>,
  options: LegacyAdoption,
): Promise<AdoptionOutcome> | null {
  if (!scope.shouldAdopt(options.legacyName, options.accountId)) return null;
  return adoptLegacyDatabase(options).then((outcome) => {
    if (outcome !== 'failed') scope.adoptionFinished(options.legacyName, options.accountId);
    return outcome;
  });
}

async function exclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return task();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCK_WAIT_MS);
  try {
    return await locks.request(name, { signal: controller.signal }, task);
  } finally {
    clearTimeout(timeout);
  }
}

async function run(options: LegacyAdoption): Promise<AdoptionOutcome> {
  const legacy = options.openLegacy(options.legacyName);
  try {
    try {
      await legacy.open();
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchDatabaseError') return 'none';
      throw error;
    }
    const existing = new Set(legacy.tables.map((table) => table.name));
    // Sem `meta` não há onde registrar a adoção: não é um banco do app.
    if (!existing.has('meta')) return 'none';

    const meta = legacy.table('meta');
    const claimedBy = await legacy.transaction('rw', meta, async () => {
      const claim = (await meta.get(CLAIM_KEY)) as { value: unknown } | undefined;
      if (claim) return claim.value;
      await meta.put({ key: CLAIM_KEY, value: options.accountId });
      return options.accountId;
    });
    if (claimedBy !== options.accountId) return 'taken';
    if (await meta.get(DONE_KEY)) return 'already';

    for (const name of options.tables) {
      if (!existing.has(name)) continue;
      const skipKey = name === 'meta' ? isAdoptionKey : undefined;
      await copyTable(legacy.table(name), options.target.table(name), skipKey);
    }

    await meta.put({ key: DONE_KEY, value: Date.now() });
    return 'adopted';
  } finally {
    legacy.close();
  }
}

function isAdoptionKey(row: Record<string, unknown>): boolean {
  return typeof row['key'] === 'string' && row['key'].startsWith('adoption:');
}

/** Copia o que ainda não existe no destino e confere que toda chave de origem está lá. Lança se faltar alguma. */
async function copyTable(
  source: Table,
  destination: Table,
  skip?: (row: Record<string, unknown>) => boolean,
): Promise<void> {
  const keyPath = destination.schema.primKey.keyPath;
  if (typeof keyPath !== 'string') {
    throw new TypeError(`A tabela ${destination.name} não tem chave simples.`);
  }
  const rows = ((await source.toArray()) as Record<string, unknown>[]).filter(
    (row) => !skip?.(row),
  );

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const present = await destination.bulkGet(chunk.map((row) => row[keyPath]));
    const fresh = chunk.filter((_, index) => present[index] === undefined);
    if (fresh.length > 0) await destination.bulkAdd(fresh);
  }

  const copied = await destination.bulkGet(rows.map((row) => row[keyPath]));
  const missing = copied.filter((row) => row === undefined).length;
  if (missing > 0) {
    throw new Error(`A adoção de ${destination.name} ficou incompleta (${missing} linhas).`);
  }
}
