import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  EnvironmentInjector,
  createEnvironmentInjector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  REQUEST_MAX_AGE_MS,
  UnsavedWork,
  registerUnsavedWork,
  unsavedWorkInterceptor,
} from './unsaved-work';

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
      const stop = work.register(() => busy, 'request');
      expect(work.hasUnsaved()).toBe(false);
      busy = true;
      expect(work.reasons()).toEqual(['request']);
      stop();
      expect(work.hasUnsaved()).toBe(false);
    });

    it('treats a source that throws as work (when in doubt, protect it)', () => {
      work.register(() => {
        throw new Error('quebrou');
      }, 'request');
      expect(work.reasons()).toEqual(['request']);
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
      expect(work.isWriting()).toBe(false);
      work.register(() => true, 'form');
      expect(work.needsConfirmation()).toBe(true);
    });
  });

  describe('fields that are not unsaved work', () => {
    it('ignores date and time pickers (a filter such as the diary day), and anything marked data-unsaved-ignore', () => {
      for (const type of ['date', 'time', 'datetime-local', 'month', 'week']) {
        const input = mount(document.createElement('input'));
        input.type = type;
        // Sem valor válido o jsdom zera o campo: o que importa é nunca entrar na vigia.
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const date = mount(document.createElement('input'));
      date.type = 'date';
      date.value = '2026-11-06';
      date.dispatchEvent(new Event('change', { bubbles: true }));
      expect(work.hasUnsaved()).toBe(false);

      const stepper = mount(document.createElement('input'));
      stepper.setAttribute('data-unsaved-ignore', '');
      type(stepper, '80');
      expect(work.hasUnsaved()).toBe(false);
    });

    it('keeps the text of a focused page region out of memory: only text fields get a starting value', () => {
      const main = mount(document.createElement('main'));
      main.tabIndex = -1;
      main.textContent = 'a página inteira';
      main.focus();
      const baselines = (work as unknown as { baselines: WeakMap<object, string> }).baselines;
      expect(baselines.has(main)).toBe(false);

      const input = mount(document.createElement('input'));
      input.focus();
      expect(baselines.has(input)).toBe(true);
    });
  });

  describe('after the work was saved but the fields stay on screen', () => {
    it('forgets the fields of a form when it is submitted, and starts over from what they show', () => {
      const form = mount(document.createElement('form'));
      form.addEventListener('submit', (event) => event.preventDefault());
      const name = document.createElement('input');
      form.appendChild(name);
      type(name, 'Perfil novo');
      expect(work.hasUnsaved()).toBe(true);

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(work.hasUnsaved()).toBe(false);

      // Mexer de novo depois de salvo conta de novo, a partir do que ficou na tela.
      type(name, 'Perfil novo 2');
      expect(work.reasons()).toEqual(['form']);
      type(name, 'Perfil novo');
      expect(work.hasUnsaved()).toBe(false);
    });

    it('forgets the watched fields when a registered editor goes from dirty to clean (it saved)', () => {
      let dirty = false;
      work.register(() => dirty, 'form');
      const field = mount(document.createElement('input'));
      type(field, 'rascunho');
      dirty = true;
      expect(work.reasons()).toEqual(['form']);

      // O editor salvou: fica limpo, mas o campo ainda mostra o texto digitado.
      dirty = false;
      expect(work.hasUnsaved()).toBe(false);
      type(field, 'rascunho 2');
      expect(work.hasUnsaved()).toBe(true);
    });

    it('does not forget anything while the editor stays dirty', () => {
      work.register(() => true, 'form');
      const field = mount(document.createElement('input'));
      type(field, 'rascunho');
      expect(work.reasons()).toEqual(['form']);
      expect(work.hasUnsaved()).toBe(true);
    });
  });

  describe('requests in flight', () => {
    it('stops counting a write that never answers, so it cannot block a reload forever', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        work.beginRequest();
        expect(work.isWriting()).toBe(true);
        vi.setSystemTime(Date.now() + REQUEST_MAX_AGE_MS - 1);
        expect(work.isWriting()).toBe(true);
        vi.setSystemTime(Date.now() + 2);
        expect(work.isWriting()).toBe(false);
        expect(work.hasUnsaved()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

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
