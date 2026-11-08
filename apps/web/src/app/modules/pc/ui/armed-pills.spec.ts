import { TestBed } from '@angular/core/testing';
import { PcArmed } from '../data/pc-armed';
import { PcArmedPills } from './armed-pills';

describe('PcArmedPills', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<PcArmedPills>>;
  let root: HTMLElement;
  let armed: PcArmed;

  beforeEach(() => {
    fixture = TestBed.createComponent(PcArmedPills);
    armed = TestBed.inject(PcArmed);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('shows nothing when nothing is armed', () => {
    expect(root.querySelector('.pills')).toBeNull();
  });

  it('shows what is armed, in the fixed order, as a named group', () => {
    armed.toggle('WIN');
    armed.toggle('CTRL');
    fixture.detectChanges();
    expect(root.querySelector('.pills')?.getAttribute('aria-label')).toBe('Teclas armadas');
    expect([...root.querySelectorAll('.pill')].map((item) => item.textContent?.trim())).toEqual([
      'Ctrl',
      'Win',
    ]);
  });

  it('each pill says what a tap does, and is not a toggle', () => {
    armed.toggle('CTRL');
    fixture.detectChanges();
    const pill = root.querySelector<HTMLButtonElement>('.pill')!;
    expect(pill.getAttribute('aria-label')).toBe('Soltar Ctrl');
    expect(pill.hasAttribute('aria-pressed')).toBe(false);
    expect(pill.textContent?.trim()).toBe('Ctrl');
  });

  it('after a tap the focus goes to the next pill, or to the previous when it was the last', () => {
    document.body.append(root);
    armed.toggle('CTRL');
    armed.toggle('ALT');
    armed.toggle('WIN');
    fixture.detectChanges();
    const names = () => [...root.querySelectorAll('.pill')].map((item) => item.textContent?.trim());
    expect(names()).toEqual(['Ctrl', 'Alt', 'Win']);
    root.querySelectorAll<HTMLButtonElement>('.pill')[1].click();
    fixture.detectChanges();
    TestBed.tick();
    expect(document.activeElement?.textContent?.trim()).toBe('Win');
    (document.activeElement as HTMLButtonElement).click();
    fixture.detectChanges();
    TestBed.tick();
    expect(document.activeElement?.textContent?.trim()).toBe('Ctrl');
    root.remove();
  });

  it('when the last pill goes away the focus goes to the fallback (the title), never to the page', () => {
    const title = document.createElement('h2');
    title.tabIndex = -1;
    document.body.append(root, title);
    fixture.componentRef.setInput('fallback', title);
    armed.toggle('WIN');
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.pill')!.click();
    fixture.detectChanges();
    TestBed.tick();
    expect(root.querySelector('.pill')).toBeNull();
    expect(document.activeElement).toBe(title);
    root.remove();
    title.remove();
  });

  it('with no fallback, losing the last pill does not throw', () => {
    armed.toggle('WIN');
    fixture.detectChanges();
    expect(() => {
      root.querySelector<HTMLButtonElement>('.pill')!.click();
      fixture.detectChanges();
      TestBed.tick();
    }).not.toThrow();
  });

  it('a tap lets that one go and leaves the others', () => {
    armed.toggle('ALT');
    armed.toggle('SHIFT');
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.pill')!.click();
    fixture.detectChanges();
    expect(armed.has('SHIFT')).toBe(false);
    expect(armed.has('ALT')).toBe(true);
    expect(root.querySelectorAll('.pill')).toHaveLength(1);
  });
});
