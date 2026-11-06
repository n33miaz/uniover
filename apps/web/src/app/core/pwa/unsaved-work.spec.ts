import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  EnvironmentInjector,
  createEnvironmentInjector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  OUTBOX_LOAD_TIMEOUT_MS,
  type OutboxProbe,
  type QueueScopesLike,
  guardOutbox,
  guardQueueScopes,
} from './outbox-guard';
import { UnsavedWork, registerUnsavedWork, unsavedWorkInterceptor } from './unsaved-work';

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('UnsavedWork', () => {
  let work: UnsavedWork;
  const added: HTMLElement[] = [];

  function mount<T extends HTMLElement>(element: T): T {
    document.body.appendChild(element);
    added.push(element);
    return element;
  }

  beforeEach(() => {
    work = TestBed.inject(UnsavedWork);
  });

  afterEach(() => {
    for (const element of added.splice(0)) element.remove();
  });

  it('starts clean', () => {
    expect(work.hasUnsaved()).toBe(false);
    expect(work.reasons()).toEqual([]);
  });

  describe('typed fields', () => {
    it('counts a text field the person typed in, and forgets it once it is empty again', () => {
      const input = mount(document.createElement('input'));
      type(input, 'Supino reto');
      expect(work.reasons()).toEqual(['form']);
      type(input, '');
      expect(work.hasUnsaved()).toBe(false);
    });

    it('counts textareas and contenteditable regions', () => {
      const area = mount(document.createElement('textarea'));
      type(area, 'nota');
      expect(work.hasUnsaved()).toBe(true);
      type(area, '');
      expect(work.hasUnsaved()).toBe(false);

      const editable = mount(document.createElement('div'));
      Object.defineProperty(editable, 'isContentEditable', { value: true });
      editable.textContent = 'texto livre';
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      expect(work.hasUnsaved()).toBe(true);
    });

    it('drops a field that left the page (the form was saved or the screen closed)', () => {
      const input = mount(document.createElement('input'));
      type(input, 'rascunho');
      expect(work.hasUnsaved()).toBe(true);
      input.remove();
      expect(work.hasUnsaved()).toBe(false);
    });

    it('ignores switches, checkboxes, radios and selects: they save on the spot and would pin the screen', () => {
      const box = mount(document.createElement('input'));
      box.type = 'checkbox';
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      const radio = mount(document.createElement('input'));
      radio.type = 'radio';
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      const select = mount(document.createElement('select'));
      select.add(new Option('a'));
      select.add(new Option('b'));
      select.selectedIndex = 1;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(work.hasUnsaved()).toBe(false);
    });

    it('never tracks a field that is empty, disconnected or not typed text', () => {
      const detached = document.createElement('input');
      type(detached, 'solto');
      const empty = mount(document.createElement('input'));
      type(empty, '');
      expect(work.hasUnsaved()).toBe(false);
      // Nada ficou retido: uma tela criada e destruída não deixa campos na vigia.
      expect((work as unknown as { edited: Set<unknown> }).edited.size).toBe(0);
    });

    it('prune releases fields that left the page, so dead screens are not held in memory', () => {
      const input = mount(document.createElement('input'));
      type(input, 'rascunho');
      const tracked = (work as unknown as { edited: Set<unknown> }).edited;
      expect(tracked.size).toBe(1);
      input.remove();
      work.prune();
      expect(tracked.size).toBe(0);
    });

    it('keeps protecting when more fields are edited than the watcher can hold', () => {
      const fields: HTMLInputElement[] = [];
      for (let i = 0; i < 201; i++) {
        const input = mount(document.createElement('input'));
        type(input, 'x');
        fields.push(input);
      }
      expect(work.hasUnsaved()).toBe(true);
      // O campo que não coube também está protegido: a conta só baixa quando campos saem.
      for (const field of fields) field.remove();
      expect(work.hasUnsaved()).toBe(false);
    });

    it('ignores search boxes, hidden and range inputs, and fields marked to be ignored', () => {
      const search = mount(document.createElement('input'));
      search.type = 'search';
      type(search, 'agachamento');
      const range = mount(document.createElement('input'));
      range.type = 'range';
      range.value = '7';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      const wrapper = mount(document.createElement('div'));
      wrapper.setAttribute('data-unsaved-ignore', '');
      const inner = document.createElement('input');
      wrapper.appendChild(inner);
      type(inner, 'filtro');
      expect(work.hasUnsaved()).toBe(false);
    });
  });

  describe('the starting value of a field (first focus)', () => {
    function focusWith(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
      // Como o Angular: a propriedade recebe o valor; o atributo `value` (defaultValue) continua vazio.
      field.value = value;
      field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    }

    it('does not count a field that came filled in until the person changes it', () => {
      const input = mount(document.createElement('input'));
      focusWith(input, 'Maria');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(work.hasUnsaved()).toBe(false);

      type(input, 'Maria Clara');
      expect(work.reasons()).toEqual(['form']);
    });

    it('counts clearing a field that came filled in (the deletion is work too)', () => {
      const input = mount(document.createElement('input'));
      focusWith(input, 'Maria');
      type(input, '');
      expect(work.reasons()).toEqual(['form']);
    });

    it('lets go once the text is back to what it was when the person focused the field', () => {
      const area = mount(document.createElement('textarea'));
      focusWith(area, 'nota antiga');
      type(area, 'nota nova');
      expect(work.hasUnsaved()).toBe(true);
      type(area, 'nota antiga');
      expect(work.hasUnsaved()).toBe(false);
    });

    it('keeps the first value: focusing again after typing does not move the starting point', () => {
      const input = mount(document.createElement('input'));
      focusWith(input, '');
      type(input, 'abc');
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(work.hasUnsaved()).toBe(true);
    });

    it('works for contenteditable too, against the text it had at the first focus', () => {
      const editable = mount(document.createElement('div'));
      Object.defineProperty(editable, 'isContentEditable', { value: true });
      editable.textContent = 'texto de partida';
      editable.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      expect(work.hasUnsaved()).toBe(false);
      editable.textContent = '';
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      expect(work.hasUnsaved()).toBe(true);
    });
  });

  describe('registered sources', () => {
    it('reports the reason of the source while it holds work, and stops after it is removed', () => {
      let busy = false;
      const stop = work.register(() => busy, 'outbox');
      expect(work.hasUnsaved()).toBe(false);
      busy = true;
      expect(work.reasons()).toEqual(['outbox']);
      stop();
      expect(work.hasUnsaved()).toBe(false);
    });

    it('treats a source that throws as work (when in doubt, protect it)', () => {
      work.register(() => {
        throw new Error('quebrou');
      }, 'outbox');
      expect(work.reasons()).toEqual(['outbox']);
    });

    it('lists each reason once', () => {
      work.register(() => true);
      work.register(() => true);
      expect(work.reasons()).toEqual(['form']);
    });

    it('registerUnsavedWork unregisters when the owner is destroyed, while the registry lives on', () => {
      const owner = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
      runInInjectionContext(owner, () => registerUnsavedWork(() => true));
      expect(work.hasUnsaved()).toBe(true);
      owner.destroy();
      expect(work.hasUnsaved()).toBe(false);
    });
  });

  describe('what a tap on the update notice has to decide', () => {
    it('asks the person only about text and dirty editors, never about writes in flight', () => {
      expect(work.needsConfirmation()).toBe(false);
      const end = work.beginRequest();
      expect(work.needsConfirmation()).toBe(false);
      expect(work.isWriting()).toBe(true);
      end();
      work.register(() => true, 'outbox');
      expect(work.needsConfirmation()).toBe(false);
      expect(work.isWriting()).toBe(true);
      work.register(() => true, 'form');
      expect(work.needsConfirmation()).toBe(true);
    });
  });

  describe('settle', () => {
    it('waits for the refreshers (a source that may be stale) before a decision', async () => {
      let stale = true;
      work.register(() => stale, 'outbox');
      work.registerRefresh(async () => {
        await Promise.resolve();
        stale = false;
      });
      expect(work.hasUnsaved()).toBe(true);
      await work.settle();
      expect(work.hasUnsaved()).toBe(false);
    });

    it('never throws and never waits longer than its limit for a refresher that fails or hangs', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        work.registerRefresh(() => Promise.reject(new Error('banco travou')));
        work.registerRefresh(() => new Promise(() => undefined));
        const done = work.settle(500);
        await vi.advanceTimersByTimeAsync(500);
        await expect(done).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops calling a refresher once it was removed', async () => {
      const refresh = vi.fn().mockResolvedValue(undefined);
      const stop = work.registerRefresh(refresh);
      stop();
      await work.settle();
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe('requests in flight', () => {
    it('counts begin and end, and ending twice does not go negative', () => {
      const end = work.beginRequest();
      const other = work.beginRequest();
      expect(work.reasons()).toEqual(['request']);
      end();
      end();
      expect(work.hasUnsaved()).toBe(true);
      other();
      expect(work.hasUnsaved()).toBe(false);
    });
  });
});

describe('unsavedWorkInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let work: UnsavedWork;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([unsavedWorkInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    work = TestBed.inject(UnsavedWork);
  });

  it('holds the reload while a write is in flight and releases it on success', () => {
    http.post('/api/v1/x', {}).subscribe();
    expect(work.reasons()).toEqual(['request']);
    controller.expectOne('/api/v1/x').flush({});
    expect(work.hasUnsaved()).toBe(false);
  });

  it('releases the reload when the write fails', () => {
    http.put('/api/v1/x', {}).subscribe({ error: () => undefined });
    expect(work.hasUnsaved()).toBe(true);
    controller.expectOne('/api/v1/x').flush('erro', { status: 500, statusText: 'erro' });
    expect(work.hasUnsaved()).toBe(false);
  });

  it('releases the reload when the caller gives up on the write', () => {
    const subscription = http.delete('/api/v1/x').subscribe();
    expect(work.hasUnsaved()).toBe(true);
    subscription.unsubscribe();
    expect(work.hasUnsaved()).toBe(false);
  });

  it('does not count reads', () => {
    http.get('/api/v1/x').subscribe();
    expect(work.hasUnsaved()).toBe(false);
    controller.expectOne('/api/v1/x').flush({});
  });
});

describe('guardOutbox', () => {
  it('counts as busy until the queue has loaded, then follows the in-flight count', async () => {
    const work = TestBed.inject(UnsavedWork);
    let pending = 0;
    let finish!: (probe: OutboxProbe) => void;
    void guardOutbox(work, () => new Promise((resolve) => (finish = resolve)));
    expect(work.reasons()).toEqual(['outbox']);

    finish({ inFlight: () => pending, refresh: () => Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
    expect(work.hasUnsaved()).toBe(false);
    pending = 2;
    expect(work.reasons()).toEqual(['outbox']);
    pending = 0;
    expect(work.hasUnsaved()).toBe(false);
  });

  it('lets go when the queue import hangs, so the watchdog is never stuck behind it', async () => {
    vi.useFakeTimers();
    try {
      const work = TestBed.inject(UnsavedWork);
      void guardOutbox(work, () => new Promise(() => undefined));
      expect(work.hasUnsaved()).toBe(true);
      await vi.advanceTimersByTimeAsync(OUTBOX_LOAD_TIMEOUT_MS);
      expect(work.hasUnsaved()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go when the queue fails to load, and hands the error back', async () => {
    const work = TestBed.inject(UnsavedWork);
    const failed = guardOutbox(work, () => Promise.reject(new Error('sem fila')));
    await expect(failed).rejects.toThrow('sem fila');
    expect(work.hasUnsaved()).toBe(false);
  });
});

describe('guardQueueScopes', () => {
  function fakeScopes(counts: { pending: number; sending: number }) {
    const refresh = vi.fn().mockImplementation(async () => {
      counts.sending = 0;
    });
    const scopes: QueueScopesLike = {
      follow: vi.fn(),
      active: () => ({
        store: {
          sendingCount: () => counts.sending,
          pendingCount: () => counts.pending,
          refresh,
        },
      }),
    } as unknown as QueueScopesLike;
    return { scopes, refresh };
  }

  it('follows the queue and reads the in-flight count, never the pending one', async () => {
    const work = TestBed.inject(UnsavedWork);
    const counts = { pending: 7, sending: 0 };
    const { scopes } = fakeScopes(counts);
    await guardQueueScopes(work, async () => scopes);

    expect(scopes.follow).toHaveBeenCalledTimes(1);
    // Sete itens esperando no aparelho, nenhum em voo: a recarga não perde nada.
    expect(work.hasUnsaved()).toBe(false);
    counts.sending = 1;
    expect(work.reasons()).toEqual(['outbox']);
  });

  it('rereads the count (other tabs share the database) when a decision calls settle', async () => {
    const work = TestBed.inject(UnsavedWork);
    const counts = { pending: 0, sending: 1 };
    const { scopes, refresh } = fakeScopes(counts);
    await guardQueueScopes(work, async () => scopes);
    expect(work.hasUnsaved()).toBe(true);

    await work.settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(work.hasUnsaved()).toBe(false);
  });

  it('counts as clean when there is no account queue yet', async () => {
    const work = TestBed.inject(UnsavedWork);
    const scopes = { follow: vi.fn(), active: () => null } as unknown as QueueScopesLike;
    await guardQueueScopes(work, async () => scopes);
    expect(work.hasUnsaved()).toBe(false);
    await expect(work.settle()).resolves.toBeUndefined();
  });
});
