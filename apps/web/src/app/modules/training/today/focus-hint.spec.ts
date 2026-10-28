import { TestBed } from '@angular/core/testing';
import { FocusHint } from './focus-hint';

function setup(inputs: { last?: string | null; tip?: { text: string; reason: string } | null }) {
  const fixture = TestBed.createComponent(FocusHint);
  fixture.componentRef.setInput('last', inputs.last ?? null);
  fixture.componentRef.setInput('tip', inputs.tip ?? null);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const toggle = () => el.querySelector<HTMLButtonElement>('button.toggle')!;
  const panel = () => el.querySelector<HTMLElement>('.panel')!;
  const reason = () => el.querySelector<HTMLElement>('.reason')!;
  const why = () => el.querySelector<HTMLButtonElement>('button.why')!;
  return { fixture, el, toggle, panel, reason, why };
}

const TIP = { text: '42,5 kg × 6–8', reason: 'Você fechou o topo da faixa na última vez.' };

describe('FocusHint', () => {
  it('starts collapsed: only the toggle is visible, and the last time and the suggestion stay hidden', () => {
    const { toggle, panel } = setup({ last: '40 kg × 10', tip: TIP });

    expect(toggle().textContent).toContain('Última Vez e Sugestão');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(panel().hidden).toBe(true);
  });

  it('opens on touch, shows both lines, and keeps the reason of the suggestion behind its own button', () => {
    const { fixture, el, toggle, panel, reason, why } = setup({ last: '40 kg × 10', tip: TIP });

    toggle().click();
    fixture.detectChanges();

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(panel().hidden).toBe(false);
    expect(el.textContent).toContain('40 kg × 10');
    expect(el.textContent).toContain('42,5 kg × 6–8');
    expect(reason().hidden).toBe(true);

    why().click();
    fixture.detectChanges();
    expect(reason().hidden).toBe(false);
    expect(why().getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsing the panel also closes the reason, so it comes back closed on the next opening', () => {
    const { fixture, toggle, panel, reason, why } = setup({ last: '40 kg × 10', tip: TIP });
    toggle().click();
    fixture.detectChanges();
    why().click();
    fixture.detectChanges();
    expect(reason().hidden).toBe(false);

    toggle().click();
    fixture.detectChanges();
    expect(panel().hidden).toBe(true);

    toggle().click();
    fixture.detectChanges();
    expect(panel().hidden).toBe(false);
    expect(reason().hidden).toBe(true);
    expect(why().getAttribute('aria-expanded')).toBe('false');
  });

  it('every aria-controls points to an element that exists, collapsed or open', () => {
    const { fixture, el, toggle, why } = setup({ last: '40 kg × 10', tip: TIP });

    const resolves = () => {
      const referenced = Array.from(el.querySelectorAll('[aria-controls]')).map((node) =>
        node.getAttribute('aria-controls'),
      );
      expect(referenced).toHaveLength(2);
      for (const id of referenced) expect(el.querySelector(`#${id}`)).not.toBeNull();
    };

    resolves();
    toggle().click();
    fixture.detectChanges();
    why().click();
    fixture.detectChanges();
    resolves();
  });
});
