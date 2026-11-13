import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { PcPrefs } from '../data/pc-prefs';
import { PcPadSettingsSheet } from './pad-settings-sheet';

describe('PcPadSettingsSheet', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<PcPadSettingsSheet>>;
  let root: HTMLElement;
  let prefs: PcPrefs;

  const pointer = () => root.querySelector<HTMLInputElement>('#pad-sensitivity')!;
  const scroll = () => root.querySelector<HTMLInputElement>('#scroll-sensitivity')!;
  /** Arrasta o controle deslizante até o nível (o navegador avisa com `input`). */
  const slide = (slider: HTMLInputElement, level: number) => {
    slider.value = String(level);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const invert = () => switchOf('Inverter rolagem');
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

  it('opens as a modal with a seven-level slider for the pointer, at the middle by default', () => {
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(pointer().type).toBe('range');
    expect([pointer().min, pointer().max, pointer().step]).toEqual(['1', '7', '1']);
    expect(pointer().value).toBe('4');
    expect(pointer().getAttribute('aria-valuetext')).toBe('4 de 7, padrão');
    expect(document.activeElement).toBe(pointer());
    expect(invert().checked).toBe(false);
  });

  it('the slider is named by its title and shows the level', () => {
    const name = root.querySelector(`#${pointer().getAttribute('aria-labelledby')}`);
    expect(name?.textContent?.trim()).toBe('Sensibilidade');
    slide(pointer(), 6);
    fixture.detectChanges();
    expect(root.querySelector('output[for="pad-sensitivity"]')?.textContent?.trim()).toBe('6');
    expect(pointer().getAttribute('aria-valuetext')).toBe('6 de 7');
  });

  it('moving the slider applies at once and is kept as a number', () => {
    slide(pointer(), 6);
    expect(prefs.sensitivity()).toBe(6);
    expect(JSON.parse(localStorage.getItem('uniover.pc.prefs.v1.sheet-user')!).sensitivity).toBe(6);
  });

  it('a value outside the scale is ignored', () => {
    slide(pointer(), 6);
    const input = pointer();
    Object.defineProperty(input, 'value', { value: '9', configurable: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(prefs.sensitivity()).toBe(6);
  });

  it('the acceleration switch brings the speed curve back', () => {
    expect(switchOf('Aceleração').checked).toBe(false);
    switchOf('Aceleração').click();
    expect(prefs.acceleration()).toBe(true);
  });

  it('a choice saved before the slider opens at its level', () => {
    fixture.destroy();
    localStorage.setItem(
      'uniover.pc.prefs.v1.sheet-user',
      JSON.stringify({ sensitivity: 'boosted', scrollSensitivity: 'low' }),
    );
    TestBed.resetTestingModule();
    TestBed.inject(SessionState).setUser({
      id: 'sheet-user',
      email: 's@example.com',
      displayName: 'S',
    });
    fixture = TestBed.createComponent(PcPadSettingsSheet);
    fixture.detectChanges();
    root = fixture.nativeElement;
    expect(pointer().value).toBe('5');
    expect(switchOf('Aceleração').checked).toBe(true);
    expect(scroll().value).toBe('2');
  });

  it('the switch to show what is typed is on by default', () => {
    expect(switchOf('Mostrar o que digito').checked).toBe(true);
    switchOf('Mostrar o que digito').click();
    expect(prefs.showTyped()).toBe(false);
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

  it('the scroll has its own slider, separate from the pointer', () => {
    expect([scroll().min, scroll().max, scroll().value]).toEqual(['1', '7', '4']);
    slide(scroll(), 7);
    expect(prefs.scrollSensitivity()).toBe(7);
    expect(prefs.sensitivity()).toBe(4);
  });

  it('the gesture switches apply at once: double-tap drag is off, the middle click is on', () => {
    expect(switchOf('Toque duplo arrasta').checked).toBe(false);
    expect(switchOf('Clique do meio com três dedos').checked).toBe(true);
    switchOf('Toque duplo arrasta').click();
    switchOf('Clique do meio com três dedos').click();
    expect(prefs.doubleTapDrag()).toBe(true);
    expect(prefs.middleClick()).toBe(false);
  });

  it('has no vibration switch where the device cannot vibrate (iPhone)', () => {
    const labels = [...root.querySelectorAll('label.row')].map((row) => row.textContent?.trim());
    expect(labels).not.toContain('Vibração');
  });

  it('is titled Settings', () => {
    expect(root.querySelector('h2')?.textContent).toBe('Ajustes');
  });

  it('opened from the touchpad, shows only the sensitivity, the rest one tap away', () => {
    fixture.destroy();
    fixture = TestBed.createComponent(PcPadSettingsSheet);
    fixture.componentRef.setInput('quick', true);
    fixture.detectChanges();
    root = fixture.nativeElement;
    expect(pointer()).not.toBeNull();
    expect(scroll()).not.toBeNull();
    expect(root.querySelectorAll('label.row')).toHaveLength(1);
    const more = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Mais ajustes',
    )!;
    more.click();
    fixture.detectChanges();
    expect(switchOf('Inverter rolagem')).toBeTruthy();
    expect(root.querySelectorAll('label.row').length).toBeGreaterThan(5);
  });

  it('Close asks the page to take the sheet away', () => {
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    root.querySelector<HTMLButtonElement>('.footer button')!.click();
    expect(closed).toBe(1);
  });
});
