import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { PcPrefs } from '../data/pc-prefs';
import { PcPadSettingsSheet } from './pad-settings-sheet';

describe('PcPadSettingsSheet', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<PcPadSettingsSheet>>;
  let root: HTMLElement;
  let prefs: PcPrefs;

  const option = (label: string) =>
    [...root.querySelectorAll<HTMLLabelElement>('.option')]
      .find((item) => item.textContent?.trim() === label)!
      .querySelector('input')!;
  const invert = () => root.querySelector<HTMLInputElement>('input[role="switch"]')!;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.inject(SessionState).setUser({
      id: 'sheet-user',
      email: 's@example.com',
      displayName: 'S',
    });
    prefs = TestBed.inject(PcPrefs);
    fixture = TestBed.createComponent(PcPadSettingsSheet);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    localStorage.clear();
  });

  it('opens as a modal and offers the four sensitivities, Normal being the one on', () => {
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    const labels = [...root.querySelectorAll('.option')].map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Baixa', 'Normal', 'Alta', 'Acelerada']);
    expect(option('Normal').checked).toBe(true);
    expect(invert().checked).toBe(false);
  });

  it('choosing a sensitivity applies at once and is kept', () => {
    option('Alta').click();
    expect(prefs.sensitivity()).toBe('high');
    expect(JSON.parse(localStorage.getItem('uniover.pc.prefs.v1.sheet-user')!).sensitivity).toBe(
      'high',
    );
  });

  it('the switch inverts the scroll and turns it back', () => {
    invert().click();
    expect(prefs.invertScroll()).toBe(true);
    invert().click();
    expect(prefs.invertScroll()).toBe(false);
  });

  it('Close asks the page to take the sheet away', () => {
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    root.querySelector<HTMLButtonElement>('.footer button')!.click();
    expect(closed).toBe(1);
  });
});
