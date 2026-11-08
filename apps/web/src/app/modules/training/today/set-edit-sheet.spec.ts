import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UnsavedWork } from '../../../core/pwa/unsaved-work';
import { localSet } from '../data/progress/progress-data-test-kit';
import { localExercise } from '../data/sync/training-test-kit';
import { LiveStore } from './live-store';
import { SetEditSheet } from './set-edit-sheet';

describe('SetEditSheet', () => {
  let fixture: ComponentFixture<SetEditSheet>;
  let el: HTMLElement;
  const live = { editSet: vi.fn(async () => null), removeSet: vi.fn(async () => null) };

  function open() {
    TestBed.configureTestingModule({ providers: [{ provide: LiveStore, useValue: live }] });
    fixture = TestBed.createComponent(SetEditSheet);
    fixture.componentRef.setInput('set', localSet('s1', 'sessao', { weightKg: 40, reps: 10 }));
    fixture.componentRef.setInput('exercise', localExercise('supino', { name: 'Supino reto' }));
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const typeLoad = (value: string) => {
    const input = el.querySelector<HTMLInputElement>('app-live-stepper input')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };

  it('is clean when opened, dirty with a changed value, clean again when the value goes back', () => {
    open();
    const unsaved = TestBed.inject(UnsavedWork);
    expect(unsaved.hasUnsaved()).toBe(false);

    typeLoad('45');
    expect(unsaved.needsConfirmation()).toBe(true);

    typeLoad('40');
    expect(unsaved.hasUnsaved()).toBe(false);
  });

  it('stops holding the reload once the sheet is closed (saved or cancelled)', () => {
    open();
    const unsaved = TestBed.inject(UnsavedWork);
    typeLoad('45');
    expect(unsaved.hasUnsaved()).toBe(true);

    fixture.destroy();
    expect(unsaved.hasUnsaved()).toBe(false);
  });
});
