import { TestBed } from '@angular/core/testing';
import { setupScreen } from '../shell/screen-test-kit';
import { BodyPage } from './body.page';
import { vi } from 'vitest';

describe('BodyPage section selector', () => {
  afterEach(() => vi.unstubAllGlobals());
  async function open() {
    await setupScreen();
    const fixture = TestBed.createComponent(BodyPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('selects panels in both directions and clears only its own entrance animation', async () => {
    const { fixture, el } = await open();
    const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>('.tabs button'));
    const content = el.querySelector<HTMLElement>('.section-content')!;

    tabs[1].click();
    fixture.detectChanges();
    expect(tabs[1].getAttribute('aria-pressed')).toBe('true');
    expect(content.classList.contains('forward')).toBe(true);

    const child = document.createElement('span');
    content.append(child);
    child.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(content.classList.contains('forward')).toBe(true);

    content.dispatchEvent(new Event('animationend'));
    fixture.detectChanges();
    expect(content.classList.contains('forward')).toBe(false);

    tabs[0].click();
    fixture.detectChanges();
    expect(tabs[0].getAttribute('aria-pressed')).toBe('true');
    expect(content.classList.contains('backward')).toBe(true);
  });

  it('changes sections without motion when reduced motion is requested', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { fixture, el } = await open();
    const tabs = el.querySelectorAll<HTMLButtonElement>('.tabs button');
    const content = el.querySelector<HTMLElement>('.section-content')!;

    tabs[2].click();
    fixture.detectChanges();
    expect(tabs[2].getAttribute('aria-pressed')).toBe('true');
    expect(content.classList.contains('forward')).toBe(false);
    expect(content.classList.contains('backward')).toBe(false);
  });
});
