import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { DirectionalRing } from './directional-ring';

describe('DirectionalRing', () => {
  let store: FakeTvStore;
  let root: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<DirectionalRing>>;

  const byLabel = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  beforeEach(() => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(DirectionalRing);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  it('is a labelled group with four arrows and the round OK in the middle', () => {
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Setas de direção',
    );
    expect(root.querySelectorAll('.seg')).toHaveLength(4);
    expect(root.querySelector('.ok')?.textContent?.trim()).toBe('OK');
  });

  it.each([
    ['Para cima', 'UP'],
    ['Para baixo', 'DOWN'],
    ['Para a esquerda', 'LEFT'],
    ['Para a direita', 'RIGHT'],
  ])('%s sends %s', async (label, key) => {
    byLabel(label).click();
    await fixture.whenStable();
    expect(store.sendKey).toHaveBeenCalledWith(key);
  });

  it('OK sends OK', async () => {
    root.querySelector<HTMLButtonElement>('.ok')!.click();
    await fixture.whenStable();
    expect(store.sendKey).toHaveBeenCalledWith('OK');
  });

  it('every part is disabled when the remote cannot send', () => {
    store.canSend.set(false);
    fixture.detectChanges();
    for (const button of root.querySelectorAll('button')) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
  });
});
