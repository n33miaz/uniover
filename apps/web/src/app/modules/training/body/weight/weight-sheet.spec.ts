import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UnsavedWork } from '../../../../core/pwa/unsaved-work';
import { setupBody } from '../../data/body/body-data-test-kit';
import { WeightSheet } from './weight-sheet';

describe('WeightSheet', () => {
  let fixture: ComponentFixture<WeightSheet>;
  let el: HTMLElement;

  async function open() {
    setupBody();
    fixture = TestBed.createComponent(WeightSheet);
    fixture.componentRef.setInput('today', '2025-10-09');
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement as HTMLElement;
  }

  const typeWeight = (value: string) => {
    const input = el.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('holds back the automatic reload while a weight is typed and not saved', async () => {
    await open();
    const unsaved = TestBed.inject(UnsavedWork);
    expect(unsaved.hasUnsaved()).toBe(false);

    typeWeight('82,4');
    expect(unsaved.hasUnsaved()).toBe(true);
    expect(unsaved.needsConfirmation()).toBe(true);

    // Apagar o que foi digitado devolve a folha ao estado limpo.
    typeWeight('');
    expect(unsaved.hasUnsaved()).toBe(false);
  });

  it('stops holding the reload once the sheet is gone', async () => {
    await open();
    typeWeight('80');
    const unsaved = TestBed.inject(UnsavedWork);
    expect(unsaved.hasUnsaved()).toBe(true);

    fixture.destroy();
    expect(unsaved.hasUnsaved()).toBe(false);
  });
});
