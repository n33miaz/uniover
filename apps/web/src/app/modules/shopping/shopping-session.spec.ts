import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { ResumeGrace } from '../../core/connectivity/resume-grace';
import { AccountScope } from '../../core/session/account-scope';
import { SHOPPING_DB_FACTORY, type ShoppingDb } from './shopping-db';
import { ShoppingSession } from './shopping-session';

/** Um banco de mentira cuja leitura o teste solta (ou derruba) quando quiser. */
class FakeDb {
  closed = false;
  private release!: () => void;
  private fail!: (error: unknown) => void;
  private readonly read = new Promise<unknown[]>((resolve, reject) => {
    this.release = () => resolve([]);
    this.fail = reject;
  });

  readonly entities = { toArray: () => this.read };
  readonly operations = { orderBy: () => ({ toArray: () => this.read }) };
  readonly meta = { get: async () => undefined };

  constructor(readonly account: string) {}

  close(): void {
    this.closed = true;
  }

  finish(): void {
    this.release();
  }

  breakDown(): void {
    this.fail(new Error('banco bloqueado'));
  }
}

describe('ShoppingSession', () => {
  let account: WritableSignal<string | null>;
  let opened: FakeDb[];

  function start(): ShoppingSession {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ShoppingSession,
        {
          provide: AccountScope,
          useValue: { id: account, sessionAccount: signal(null), isSessionOf: () => true },
        },
        { provide: ConnectivityService, useValue: { online: signal(false) } },
        {
          provide: ResumeGrace,
          useValue: { subscribe: () => () => undefined, active: () => false, afterEnd: () => () => undefined },
        },
        {
          provide: SHOPPING_DB_FACTORY,
          useValue: (id: string) => {
            const db = new FakeDb(id);
            opened.push(db);
            return db as unknown as ShoppingDb;
          },
        },
      ],
    });
    const session = TestBed.inject(ShoppingSession);
    TestBed.tick();
    return session;
  }

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
  };

  beforeEach(() => {
    account = signal<string | null>('a');
    opened = [];
  });

  it('a database that does not open shows a failure, not a wait without end, and retry opens it', async () => {
    const session = start();
    expect(session.failed()).toBe(false);
    opened[0].breakDown();
    await settle();

    expect(session.store()).toBeNull();
    expect(session.failed()).toBe(true);
    expect(opened[0].closed).toBe(true);

    session.retry();
    expect(session.failed()).toBe(false);
    expect(opened).toHaveLength(2);
    opened[1].finish();
    await settle();

    expect(session.failed()).toBe(false);
    expect(session.store()).not.toBeNull();
  });

  it('a failed opening of an account the person has left is not shown as a failure of the new one', async () => {
    const session = start();
    account.set('b');
    TestBed.tick();
    opened[0].breakDown();
    await settle();

    expect(session.failed()).toBe(false);
    opened[1].finish();
    await settle();
    expect(session.store()).not.toBeNull();
  });

  it('switching A, B, A while the first opening waits keeps one store of A and closes the one that lost', async () => {
    const session = start();
    account.set('b');
    TestBed.tick();
    account.set('a');
    TestBed.tick();
    expect(opened.map((db) => db.account)).toEqual(['a', 'b', 'a']);

    opened[0].finish();
    await settle();
    expect(session.store()).toBeNull();
    expect(opened[0].closed).toBe(true);

    opened[2].finish();
    await settle();
    const published = session.store();
    expect(published).not.toBeNull();
    opened[1].finish();
    await settle();

    expect(session.store()).toBe(published);
    expect(opened[1].closed).toBe(true);
    expect(opened.filter((db) => !db.closed)).toEqual([opened[2]]);
  });
});
