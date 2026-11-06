import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  EnvironmentInjector,
  createEnvironmentInjector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { guardOutbox } from './outbox-guard';
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
      }, 'session');
      expect(work.reasons()).toEqual(['session']);
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
  it('counts as busy until the queue has loaded, then follows the pending count', async () => {
    const work = TestBed.inject(UnsavedWork);
    let pending = 0;
    let finish!: (read: () => number) => void;
    void guardOutbox(work, () => new Promise((resolve) => (finish = resolve)));
    expect(work.reasons()).toEqual(['outbox']);

    finish(() => pending);
    await Promise.resolve();
    await Promise.resolve();
    expect(work.hasUnsaved()).toBe(false);
    pending = 2;
    expect(work.reasons()).toEqual(['outbox']);
    pending = 0;
    expect(work.hasUnsaved()).toBe(false);
  });

  it('lets go when the queue fails to load, and hands the error back', async () => {
    const work = TestBed.inject(UnsavedWork);
    const failed = guardOutbox(work, () => Promise.reject(new Error('sem fila')));
    await expect(failed).rejects.toThrow('sem fila');
    expect(work.hasUnsaved()).toBe(false);
  });
});
