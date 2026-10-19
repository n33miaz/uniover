import { TestBed } from '@angular/core/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { SessionState } from '../session/session-state';
import { SendOutcome } from './classify-result';
import { OFFLINE_DB, OfflineDb } from './offline-db';
import { OfflineQueue } from './offline-queue';
import { OutboxStore } from './outbox-store';
import { LockResult, QUEUE_LOCKS, QUEUE_RUNTIME, QueueLocks, QueueRuntime } from './queue-ports';
import { QUEUE_TRANSPORT, QueueRequest, QueueTransport } from './queue-transport';
import { SyncEngine } from './sync-engine';

/**
 * Peças de teste da fila: banco em memória, relógio falso, bloqueio entre abas simulado e transporte roteirizado.
 * Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */

let databaseCounter = 0;

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
  script: Scripted[] = [];
  fallback: SendOutcome = ok(201);
  /** Enquanto definido, todo envio espera por ele (mantém o item em voo). */
  gate: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;

  async send(request: QueueRequest): Promise<SendOutcome> {
    this.requests.push(request);
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

/** Monta o TestBed com todas as portas da fila trocadas por versões de teste. */
export function setupQueue(db: OfflineDb = createTestDb()) {
  const runtime = new FakeRuntime();
  const locks = new FakeLocks();
  const transport = new FakeTransport();
  TestBed.configureTestingModule({
    providers: [
      { provide: OFFLINE_DB, useValue: db },
      { provide: QUEUE_RUNTIME, useValue: runtime },
      { provide: QUEUE_LOCKS, useValue: locks },
      { provide: QUEUE_TRANSPORT, useValue: transport },
    ],
  });
  return {
    db,
    runtime,
    locks,
    transport,
    /** Sem sessão o motor não envia: serve para gravar vários itens sem que o envio comece no meio. */
    pause: () => TestBed.inject(SessionState).clear('anonymous'),
    resume: () => TestBed.inject(SessionState).clear('unknown'),
    queue: () => TestBed.inject(OfflineQueue),
    engine: () => TestBed.inject(SyncEngine),
    store: () => TestBed.inject(OutboxStore),
  };
}

export const NEW_ITEM = {
  method: 'POST',
  url: '/api/v1/test/items',
  body: { name: 'x' },
  module: 'teste',
} as const;
