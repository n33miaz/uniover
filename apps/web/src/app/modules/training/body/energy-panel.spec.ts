import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { UnsavedWork } from '../../../core/pwa/unsaved-work';
import { setupTraining } from '../data/sync/training-test-kit';
import type { EnergyState } from './body-store';
import { BodyEnergyPanel } from './energy-panel';

describe('BodyEnergyPanel', () => {
  let fixture: ComponentFixture<BodyEnergyPanel>;
  let el: HTMLElement;
  const ready: EnergyState = {
    kind: 'ready',
    weightKg: 80,
    bmr: 1700,
    factor: 1.55,
    expenditure: 2635,
    chosen: null,
    target: 2635,
    clamped: false,
  };

  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;

  async function open() {
    const training = setupTraining();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    training.pause();
    fixture = TestBed.createComponent(BodyEnergyPanel);
    fixture.componentRef.setInput('state', ready);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const typeGoal = (value: string) => {
    const input = el.querySelector<HTMLInputElement>('#body-daily-goal')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };

  it('is clean until the goal is edited, dirty with a changed value, and clean after cancelling', async () => {
    await open();
    const unsaved = TestBed.inject(UnsavedWork);
    expect(unsaved.hasUnsaved()).toBe(false);

    button('Escolher Meta').click();
    fixture.detectChanges();
    // Abrir o campo, com o valor sugerido, ainda não é trabalho a perder.
    expect(unsaved.hasUnsaved()).toBe(false);

    typeGoal('2400');
    expect(unsaved.needsConfirmation()).toBe(true);

    button('Cancelar').click();
    fixture.detectChanges();
    expect(unsaved.hasUnsaved()).toBe(false);
  });
});
