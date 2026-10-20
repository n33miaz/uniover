import { TestBed } from '@angular/core/testing';
import { PageDots } from './page-dots';

describe('PageDots', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<PageDots>>;
  let root: HTMLElement;
  let selected: ReturnType<typeof vi.fn<(index: number) => void>>;

  const dots = () => [...root.querySelectorAll<HTMLButtonElement>('.dot')];

  beforeEach(() => {
    fixture = TestBed.createComponent(PageDots);
    fixture.componentRef.setInput('current', 0);
    selected = vi.fn<(index: number) => void>();
    fixture.componentInstance.choose.subscribe(selected);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  it('is a labelled group with one named button per page', () => {
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Páginas do controle',
    );
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'Página 1 de 2',
      'Página 2 de 2',
    ]);
  });

  it('marks the page in view with aria-current, not only with color', () => {
    expect(dots().map((dot) => dot.getAttribute('aria-current'))).toEqual(['true', null]);
    fixture.componentRef.setInput('current', 1);
    fixture.detectChanges();
    expect(dots().map((dot) => dot.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('tells which page was chosen', () => {
    dots()[1].click();
    expect(selected).toHaveBeenCalledWith(1);
  });

  it('follows the page count', () => {
    fixture.componentRef.setInput('count', 3);
    fixture.detectChanges();
    expect(dots()).toHaveLength(3);
    expect(dots()[2].getAttribute('aria-label')).toBe('Página 3 de 3');
  });

  it('the arrow keys move to the neighbour page and stop at the ends', () => {
    const group = root.querySelector('[role="group"]')!;
    const press = (key: string) =>
      group.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    press('ArrowLeft');
    expect(selected).not.toHaveBeenCalled();
    press('ArrowRight');
    expect(selected).toHaveBeenLastCalledWith(1);
    fixture.componentRef.setInput('current', 1);
    fixture.detectChanges();
    press('ArrowRight');
    expect(selected).toHaveBeenCalledTimes(1);
    press('ArrowLeft');
    expect(selected).toHaveBeenLastCalledWith(0);
    press('Enter');
    expect(selected).toHaveBeenCalledTimes(2);
  });
});
