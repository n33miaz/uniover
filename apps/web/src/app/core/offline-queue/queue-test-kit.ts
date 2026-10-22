import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import Dexie from 'dexie';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { AccountScope } from '../session/account-scope';
import { DB_CLOSE_GRACE_MS } from '../session/db-close';
import { LEGACY_DB_OPENER } from '../session/legacy-adoption';
import { SessionState } from '../session/session-state';
import { SendOutcome } from './classify-result';
import { DATABASE_NAME, OFFLINE_DB_FACTORY, OfflineDb, offlineDbName } from './offline-db';
import { OfflineQueue } from './offline-queue';
import { LockResult, QUEUE_LOCKS, QUEUE_RUNTIME, QueueLocks, QueueRuntime } from './queue-ports';
import { QueueScopes } from './queue-scopes';
import { QUEUE_TRANSPORT, QueueRequest, QueueTransport } from './queue-transport';

/**
 * Peças de teste da fila: banco em memória, relógio falso, bloqueio entre abas simulado e transporte roteirizado.
 * Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */

let databaseCounter = 0;

/** A conta que os testes usam quando não falam de contas: está sempre entrada, com o `/me` carregado. */
export const TEST_ACCOUNT = 'conta-teste';

/**
 * A porta de contas dos testes (no lugar da sessão e do `localStorage`, que os arquivos de teste dividem): `id` é a conta cujo
 * banco se abre; `sessionAccount` é a conta a quem o token em memória pertence (o que `/me` diz). O teste muda os dois para
 * simular a troca de pessoa.
 */
export class FakeAccountScope {
  readonly id = signal<string | null>(TEST_ACCOUNT);
  readonly sessionAccount = signal<string | null>(TEST_ACCOUNT);
  readonly legacyDecided = signal(true);
  /** Quem adota os bancos antigos (ninguém, a menos que o teste diga). */
  legacyOwner: string | null = null;

  isSessionOf(accountId: string): boolean {
    return this.sessionAccount() === accountId;
  }

  isLegacyOwner(accountId: string): boolean {
    return this.legacyOwner === accountId;
  }

  /** Bancos antigos cuja adoção já terminou (os nomes), como a memória do aparelho faria. */
  readonly adopted = new Set<string>();

  shouldAdopt(legacyName: string, accountId: string): boolean {
    return this.legacyOwner === accountId && !this.adopted.has(legacyName);
  }

  adoptionFinished(legacyName: string): void {
    this.adopted.add(legacyName);
  }

  /** Outra pessoa entra: a conta e a sessão passam a ser dela. */
  signInAs(accountId: string | null): void {
    this.id.set(accountId);
    this.sessionAccount.set(accountId);
  }
}

/** Banco isolado por teste (fábrica própria do IndexedDB e nome único); passar a mesma fábrica simula reabrir o app. */
export function createTestDb(factory: IDBFactory = new FakeIDBFactory()): OfflineDb {
  databaseCounter++;
  return new OfflineDb(`uniover-offline-teste-${databaseCounter}`, {
    indexedDB: factory,
    IDBKeyRange: FakeIDBKeyRange,
  });
}

/** Relógio e temporizadores que só andam quando o teste manda. O IndexedDB continua usando os temporizadores reais. */
export class FakeRuntime implements QueueRuntime {
  time = 1_760_000_000_000;
  randomValue = 0.5;

  private nextId = 1;
  private readonly timers = new Map<number, { at: number; every: number | null; fn: () => void }>();

  now(): number {
    return this.time;
  }

  random(): number {
    return this.randomValue;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, every: null, fn });
    return id;
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, every: ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Quantos temporizadores estão ativos agora. */
  get activeTimers(): number {
    return this.timers.size;
  }

  /** Anda o relógio e dispara, em ordem, o que vencer no caminho. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (nextId === null || timer.at < this.timers.get(nextId)!.at)) {
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.time = Math.max(this.time, timer.at);
      if (timer.every === null) this.timers.delete(nextId);
      else timer.at += timer.every;
      timer.fn();
    }
    this.time = target;
  }
}

/** Bloqueio compartilhado: dois motores com o mesmo `FakeLocks` se comportam como duas abas. */
export class FakeLocks implements QueueLocks {
  private readonly held = new Set<string>();

  /** Simula outra aba segurando o bloqueio até chamar o que esta função devolve. */
  holdExternally(name: string): () => void {
    this.held.add(name);
    return () => this.held.delete(name);
  }

  async tryRun<T>(name: string, task: () => Promise<T>): Promise<LockResult<T>> {
    if (this.held.has(name)) return { ran: false };
    this.held.add(name);
    try {
      return { ran: true, value: await task() };
    } finally {
      this.held.delete(name);
    }
  }
}

export const ok = (status = 200, headers: Record<string, string> = {}): SendOutcome => ({
  kind: 'response',
  status,
  headers,
});

export const problem = (
  status: number,
  problemType: string,
  headers: Record<string, string> = {},
): SendOutcome => ({ kind: 'response', status, headers, problemType });

export const networkError = (): SendOutcome => ({ kind: 'network-error' });

type Scripted = SendOutcome | (() => Promise<SendOutcome>);

/** Transporte roteirizado: devolve os resultados na ordem; depois do roteiro, `fallback`. */
export class FakeTransport implements QueueTransport {
  readonly requests: QueueRequest[] = [];
  /** De quem era a sessão (o token) no instante de cada envio, na mesma ordem de `requests`. */
  readonly sentAs: (string | null)[] = [];
  script: Scripted[] = [];
  fallback: SendOutcome = ok(201);
  /** Enquanto definido, todo envio espera por ele (mantém o item em voo). */
  gate: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly sessionAccount: () => string | null = () => null) {}

  async send(request: QueueRequest): Promise<SendOutcome> {
    this.requests.push(request);
    this.sentAs.push(this.sessionAccount());
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate) await this.gate;
      const next = this.script.shift();
      if (typeof next === 'function') return await next();
      return next ?? this.fallback;
    } finally {
      this.inFlight--;
    }
  }

  get keys(): string[] {
    return this.requests.map((r) => r.headers['Idempotency-Key']);
  }
}

/** Uma porta que o teste abre quando quiser. */
export function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Monta o TestBed com todas as portas da fila trocadas por versões de teste. `db` é o banco da conta de teste; a de outras
 * contas (`kit.dbOf`) e o banco antigo (`kit.legacyDb`) moram na mesma fábrica falsa do IndexedDB, então reabrir é achar
 * os mesmos dados.
 */
export function setupQueue(db: OfflineDb = createTestDb()) {
  const runtime = new FakeRuntime();
  const locks = new FakeLocks();
  const account = new FakeAccountScope();
  const transport = new FakeTransport(() => account.sessionAccount());
  const idb = new FakeIDBFactory();
  const options = { indexedDB: idb, IDBKeyRange: FakeIDBKeyRange };
  const others = new Map<string, OfflineDb>();
  const dbOf = (accountId: string): OfflineDb => {
    if (accountId === TEST_ACCOUNT) return db;
    let other = others.get(accountId);
    if (!other) {
      other = new OfflineDb(offlineDbName(accountId), options);
      others.set(accountId, other);
    }
    return other;
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: AccountScope, useValue: account },
      // Sem folga: o banco de uma conta que saiu fecha na hora, e o teste confere isso sem esperar relógio.
      { provide: DB_CLOSE_GRACE_MS, useValue: 0 },
      {
        provide: OFFLINE_DB_FACTORY,
        // A conta de teste usa o banco que o teste já tem em mãos; as outras abrem o delas na fábrica falsa.
        useValue: (name: string) =>
          name === offlineDbName(TEST_ACCOUNT) ? db : new OfflineDb(name, options),
      },
      { provide: LEGACY_DB_OPENER, useValue: (name: string) => new Dexie(name, options) },
      { provide: QUEUE_RUNTIME, useValue: runtime },
      { provide: QUEUE_LOCKS, useValue: locks },
      { provide: QUEUE_TRANSPORT, useValue: transport },
    ],
  });
  return {
    db,
    account,
    /** A fábrica falsa do IndexedDB das outras contas e dos bancos antigos, e as opções para abrir um banco nela. */
    dbOptions: options,
    runtime,
    locks,
    transport,
    /** O banco do teste das contas que não são a de teste (aberto à parte; o do app é outra conexão ao mesmo banco). */
    dbOf,
    /** O banco do tempo em que havia um só por aparelho, na mesma fábrica falsa (para o teste de adoção). */
    legacyDb: () => new OfflineDb(DATABASE_NAME, options),
    /** Sem sessão o motor não envia: serve para gravar vários itens sem que o envio comece no meio. */
    pause: () => TestBed.inject(SessionState).clear('anonymous'),
    resume: () => TestBed.inject(SessionState).clear('unknown'),
    queue: () => TestBed.inject(OfflineQueue),
    scopes: () => TestBed.inject(QueueScopes),
    /** O motor e a loja da conta em uso (a fila dela é aberta na primeira vez que alguém a pede). */
    engine: () => TestBed.inject(QueueScopes).sync()!.engine,
    store: () => TestBed.inject(QueueScopes).sync()!.store,
  };
}

export const NEW_ITEM = {
  method: 'POST',
  url: '/api/v1/test/items',
  body: { name: 'x' },
  module: 'teste',
} as const;
