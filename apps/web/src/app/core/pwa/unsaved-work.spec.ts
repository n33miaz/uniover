import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  EnvironmentInjector,
  createEnvironmentInjector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AUTO_REQUEST_MAX_AGE_MS,
  REQUEST_MAX_AGE_MS,
  UnsavedWork,
  registerUnsavedWork,
  unsavedWorkInterceptor,
} from './unsaved-work';

describe('UnsavedWork', () => {
  let work: UnsavedWork;

  beforeEach(() => {
    work = TestBed.inject(UnsavedWork);
  });

  it('starts clean', () => {
    expect(work.hasUnsaved()).toBe(false);
    expect(work.reasons()).toEqual([]);
  });

  it('does not watch the page: typing in a field with no registered editor behind it is not "unsaved work"', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.value = 'texto solto';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(work.hasUnsaved()).toBe(false);
    input.remove();
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
      }, 'form');
      expect(work.reasons()).toEqual(['form']);
      expect(work.needsConfirmation()).toBe(true);
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
    it('asks the person only about dirty editors, never about writes in flight', () => {
      expect(work.needsConfirmation()).toBe(false);
      const end = work.beginRequest();
      expect(work.needsConfirmation()).toBe(false);
      expect(work.isWriting()).toBe(true);
      end();
      expect(work.isWriting()).toBe(false);
      work.register(() => true, 'form');
      expect(work.needsConfirmation()).toBe(true);
    });

    it('can tell two snapshots of the dirty editors apart (what was dirty at acceptance, and what is dirty now)', () => {
      let first = true;
      let second = false;
      const a = () => first;
      const b = () => second;
      work.register(a);
      work.register(b);
      expect(work.dirtySources()).toEqual([a]);
      second = true;
      expect(work.dirtySources()).toEqual([a, b]);
      first = false;
      expect(work.dirtySources()).toEqual([b]);
    });

    it('does not list a request-reason source as a dirty editor', () => {
      work.register(() => true, 'request');
      expect(work.dirtySources()).toEqual([]);
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

    it('lets the tap stop waiting for a write that never answers after 30 s, while an automatic reload keeps deferring', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        work.beginRequest();
        expect(work.isWriting()).toBe(true);
        vi.setSystemTime(Date.now() + REQUEST_MAX_AGE_MS - 1);
        expect(work.isWriting()).toBe(true);
        vi.setSystemTime(Date.now() + 2);
        expect(work.isWriting()).toBe(false);
        // Um upload lento ainda é protegido da recarga automática.
        expect(work.hasUnsaved()).toBe(true);
        expect(work.reasons()).toEqual(['request']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets go of a hung request for the automatic reload too, but only after 5 minutes', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        work.beginRequest();
        vi.setSystemTime(Date.now() + AUTO_REQUEST_MAX_AGE_MS - 1);
        expect(work.hasUnsaved()).toBe(true);
        vi.setSystemTime(Date.now() + 2);
        expect(work.hasUnsaved()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
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
