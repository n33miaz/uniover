import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UnsavedWork } from '../../../core/pwa/unsaved-work';
import { setupBody } from '../data/body/body-data-test-kit';
import type { LocalBodyProfile } from '../data/body/body-profile';
import { BodyProfileSheet } from './profile-sheet';

describe('BodyProfileSheet', () => {
  let fixture: ComponentFixture<BodyProfileSheet>;
  let el: HTMLElement;

  function open(profile: LocalBodyProfile | null) {
    setupBody();
    fixture = TestBed.createComponent(BodyProfileSheet);
    fixture.componentRef.setInput('today', '2025-10-09');
    fixture.componentRef.setInput('profile', profile);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const typeHeight = (value: string) => {
    const input = el.querySelector<HTMLInputElement>('input.ui-input')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };

  const saved = {
    heightCm: 175,
    birthDate: '1995-06-15',
    sex: 'male',
    activityFactor: 1.55,
    updatedAt: 1,
    clientUpdatedAt: 1,
  } as LocalBodyProfile;

  it('is clean when opened empty or with the saved profile', () => {
    open(null);
    expect(TestBed.inject(UnsavedWork).hasUnsaved()).toBe(false);
    fixture.destroy();
    TestBed.resetTestingModule();

    open(saved);
    expect(TestBed.inject(UnsavedWork).hasUnsaved()).toBe(false);
  });

  it('is dirty with a changed height, clean when it goes back, and clean once the sheet is gone', () => {
    open(saved);
    const unsaved = TestBed.inject(UnsavedWork);
    typeHeight('180');
    expect(unsaved.needsConfirmation()).toBe(true);

    typeHeight('175');
    expect(unsaved.hasUnsaved()).toBe(false);

    typeHeight('181');
    expect(unsaved.hasUnsaved()).toBe(true);
    fixture.destroy();
    expect(unsaved.hasUnsaved()).toBe(false);
  });
});
