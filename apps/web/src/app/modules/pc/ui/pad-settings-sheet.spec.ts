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
  const switchOf = (label: string) =>
    [...root.querySelectorAll<HTMLLabelElement>('label.row')]
      .find((row) => row.textContent?.trim() === label)!
      .querySelector('input')!;

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

  it('the click buttons are off and the screen stays awake by default, and each switch applies at once', () => {
    expect(switchOf('Botões de clique').checked).toBe(false);
    expect(switchOf('Manter a tela acesa').checked).toBe(true);
    switchOf('Botões de clique').click();
    switchOf('Manter a tela acesa').click();
    expect(prefs.clickButtons()).toBe(true);
    expect(prefs.keepAwake()).toBe(false);
  });

  it('is titled Settings', () => {
    expect(root.querySelector('h2')?.textContent).toBe('Ajustes');
  });

  it('Close asks the page to take the sheet away', () => {
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    root.querySelector<HTMLButtonElement>('.footer button')!.click();
    expect(closed).toBe(1);
  });
});
