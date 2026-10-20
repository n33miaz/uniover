import { TestBed } from '@angular/core/testing';
import { TvShortcut } from '../data/tv-types';
import { makeShortcut } from '../tv-test-kit';
import { ShortcutRow } from './shortcut-row';

describe('ShortcutRow', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ShortcutRow>>;
  let root: HTMLElement;
  let askedApps: ReturnType<typeof vi.fn<(button: HTMLElement) => void>>;
  let opened: ReturnType<typeof vi.fn<(shortcut: TvShortcut) => void>>;

  const chips = () => [...root.querySelectorAll<HTMLButtonElement>('.shortcut')];

  beforeEach(() => {
    fixture = TestBed.createComponent(ShortcutRow);
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1),
      makeShortcut(2, { customLabel: 'Sala' }),
    ]);
    askedApps = vi.fn<(button: HTMLElement) => void>();
    opened = vi.fn<(shortcut: TvShortcut) => void>();
    fixture.componentInstance.apps.subscribe(askedApps);
    fixture.componentInstance.open.subscribe(opened);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  it('puts the fixed Apps chip first and the shortcuts, named by position or by the owner, after it', () => {
    const chip = root.querySelector<HTMLButtonElement>('.top > .apps-chip')!;
    expect(chip.textContent?.trim()).toBe('Apps');
    expect(chip.getAttribute('aria-label')).toBe('Apps da TV');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.closest('.shortcuts')).toBeNull();
    expect(chips().map((el) => el.textContent?.trim())).toEqual(['Atalho 1', 'Sala']);
  });

  it('hands over the Apps button itself, so the panel can give the focus back to it', () => {
    const chip = root.querySelector<HTMLButtonElement>('.apps-chip')!;
    chip.click();
    expect(askedApps).toHaveBeenCalledWith(chip);
  });

  it('tells which shortcut was tapped', () => {
    chips()[1].click();
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
  });

  it('dims the chips without taking them out of the tab order when it cannot send', () => {
    expect(chips()[0].hasAttribute('aria-disabled')).toBe(false);
    fixture.componentRef.setInput('canSend', false);
    fixture.detectChanges();
    expect(chips()[0].getAttribute('aria-disabled')).toBe('true');
    expect(chips()[0].disabled).toBe(false);
  });

  it('shows only the Apps chip when there are no shortcuts', () => {
    fixture.componentRef.setInput('shortcuts', []);
    fixture.detectChanges();
    expect(chips()).toHaveLength(0);
    expect(root.querySelector('.top')?.textContent?.trim()).toBe('Apps');
  });
});
