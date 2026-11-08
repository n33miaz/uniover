import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PcSwitcher } from '../data/pc-switcher';
import { PcSwitcherBar } from './switcher-bar';

describe('PcSwitcherBar', () => {
  const active = signal(false);
  const releasing = signal(false);
  const switcher = {
    active,
    releasing,
    next: vi.fn(),
    previous: vi.fn(),
    release: vi.fn(() => Promise.resolve(null)),
  };
  let fixture: ReturnType<typeof TestBed.createComponent<PcSwitcherBar>>;
  let root: HTMLElement;
  const button = (name: string) =>
    root.querySelector<HTMLButtonElement>(`[data-switch="${name}"]`)!;

  beforeEach(() => {
    active.set(false);
    releasing.set(false);
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: PcSwitcher, useValue: switcher }] });
    fixture = TestBed.createComponent(PcSwitcherBar);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });
  afterEach(() => fixture.destroy());

  it('shows nothing while the Alt is not held', () => {
    expect(root.querySelector('.bar')).toBeNull();
  });

  it('shows that the Alt is held, with previous, next and release, and goes away when it is let go', () => {
    active.set(true);
    fixture.detectChanges();
    expect(root.querySelector('.bar')?.getAttribute('aria-label')).toBe('Trocando de janela');
    expect(root.querySelector('.held')?.textContent?.trim()).toBe('Alt');
    expect(root.querySelector('.state')?.textContent).toContain('segurado');
    expect(button('previous').textContent).toContain('Anterior');
    expect(button('next').textContent).toContain('Próxima');
    expect(button('release').textContent).toContain('Soltar');
    active.set(false);
    fixture.detectChanges();
    expect(root.querySelector('.bar')).toBeNull();
  });

  it('while releasing, the three buttons are off (no Tab can follow a Soltar)', () => {
    active.set(true);
    fixture.detectChanges();
    expect(['previous', 'next', 'release'].map((name) => button(name).disabled)).toEqual([
      false,
      false,
      false,
    ]);
    releasing.set(true);
    fixture.detectChanges();
    expect(['previous', 'next', 'release'].map((name) => button(name).disabled)).toEqual([
      true,
      true,
      true,
    ]);
    button('next').click();
    expect(switcher.next).not.toHaveBeenCalled();
  });

  it('the buttons call previous, next and release', () => {
    active.set(true);
    fixture.detectChanges();
    button('next').click();
    button('previous').click();
    button('release').click();
    expect(switcher.next).toHaveBeenCalledTimes(1);
    expect(switcher.previous).toHaveBeenCalledTimes(1);
    expect(switcher.release).toHaveBeenCalledTimes(1);
  });
});
