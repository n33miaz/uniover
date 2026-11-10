import {
  EnvironmentInjector,
  createEnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UnsavedWork } from '../../../core/pwa/unsaved-work';
import type { LocalSession } from '../data/sessions/session';
import { registerOpenSessionWork } from './open-session-work';

const session = (finishedAt: number | null): LocalSession =>
  ({ id: 's1', finishedAt }) as unknown as LocalSession;

describe('registerOpenSessionWork: o treino aberto segura a recarga automática', () => {
  function mount(current: () => LocalSession | undefined) {
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    runInInjectionContext(injector, () => registerOpenSessionWork(current));
    return injector;
  }

  it('holds the reload while the session is open, without asking the person to save anything', () => {
    const open = signal<LocalSession | undefined>(session(null));
    mount(open);
    const work = TestBed.inject(UnsavedWork);
    expect(work.reasons()).toEqual(['session']);
    expect(work.hasUnsaved()).toBe(true);
    expect(work.needsConfirmation()).toBe(false);
  });

  it('lets go when the session ends or is not loaded yet', () => {
    const current = signal<LocalSession | undefined>(undefined);
    mount(current);
    const work = TestBed.inject(UnsavedWork);
    expect(work.hasUnsaved()).toBe(false);

    current.set(session(null));
    expect(work.hasUnsaved()).toBe(true);
    current.set(session(Date.now()));
    expect(work.hasUnsaved()).toBe(false);
  });

  it('lets go when the screen is destroyed', () => {
    const injector = mount(() => session(null));
    const work = TestBed.inject(UnsavedWork);
    expect(work.hasUnsaved()).toBe(true);
    injector.destroy();
    expect(work.hasUnsaved()).toBe(false);
  });
});
