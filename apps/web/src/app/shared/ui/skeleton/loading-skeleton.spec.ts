import { TestBed } from '@angular/core/testing';
import { LoadingKind, LoadingSkeleton } from './loading-skeleton';

function render(kind: LoadingKind, count?: number) {
  const fixture = TestBed.createComponent(LoadingSkeleton);
  fixture.componentRef.setInput('kind', kind);
  if (count !== undefined) fixture.componentRef.setInput('count', count);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('LoadingSkeleton', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({}).compileComponents();
  });

  it('shows an accessible, decorative shimmer while a section is waiting', () => {
    const host = render('cards');

    const status = host.querySelector('[role="status"]') as HTMLElement;
    expect(host.querySelector('app-loading-frame')?.getAttribute('aria-busy')).toBe('true');
    // O leitor de tela ouve um texto só; as formas ficam escondidas dele.
    expect(status.textContent?.trim()).toBe('Carregando conteúdo…');
    expect(host.querySelector('.shape')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(2);
  });

  it('draws the shape of each kind of wait', () => {
    expect(render('cards').querySelectorAll('.card').length).toBe(3);
    expect(render('group').querySelectorAll('.row').length).toBe(4);
    expect(render('group').querySelectorAll('.chip').length).toBe(4);
    expect(render('options').querySelectorAll('.option').length).toBe(3);
    expect(render('metrics').querySelectorAll('.tile').length).toBe(4);
    expect(render('log').querySelectorAll('.log .ui-skeleton').length).toBe(6);
    expect(render('groups').querySelectorAll('.fields').length).toBe(2);
    expect(render('groups').querySelectorAll('.fields .input.ui-skeleton').length).toBe(4);
    expect(render('qr').querySelectorAll('.square.ui-skeleton').length).toBe(1);
  });

  it('repeats the shape as many times as the screen needs', () => {
    expect(render('cards', 2).querySelectorAll('.card').length).toBe(2);
    expect(render('options', 5).querySelectorAll('.option').length).toBe(5);
  });
});
