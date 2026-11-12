import { TestBed } from '@angular/core/testing';
import type { TvNotice } from '../data/tv-store';
import { TvToast } from './tv-toast';

describe('TvToast', () => {
  const render = (notice: TvNotice | null) => {
    const fixture = TestBed.createComponent(TvToast);
    fixture.componentRef.setInput('notice', notice);
    fixture.detectChanges();
    return fixture;
  };
  const toasts = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.toast')];

  it('shows an error as an alert and anything else as a calm status', () => {
    const fixture = render({ kind: 'error', text: 'A TV não está respondendo.' });
    const root = fixture.nativeElement as HTMLElement;
    expect(toasts(root)).toHaveLength(1);
    expect(toasts(root)[0].getAttribute('role')).toBe('alert');
    expect(toasts(root)[0].classList.contains('error')).toBe(true);
    fixture.componentRef.setInput('notice', { kind: 'info', text: 'Lista de apps atualizada.' });
    fixture.detectChanges();
    expect(toasts(root)[0].getAttribute('role')).toBe('status');
    expect(toasts(root)[0].classList.contains('error')).toBe(false);
  });

  it('one notice at a time: a new one replaces the text of the element that is already there', () => {
    const fixture = render({ kind: 'error', text: 'A TV não está respondendo.' });
    const root = fixture.nativeElement as HTMLElement;
    const shown = toasts(root)[0];
    fixture.componentRef.setInput('notice', { kind: 'info', text: 'Lista de apps atualizada.' });
    fixture.detectChanges();
    expect(toasts(root)).toEqual([shown]); // o mesmo elemento: nada saindo por baixo
    expect(shown.textContent?.trim()).toBe('Lista de apps atualizada.');
  });

  it('the same message again neither stacks nor restarts', () => {
    const fixture = render({ kind: 'error', text: 'A TV não está respondendo.' });
    const root = fixture.nativeElement as HTMLElement;
    const shown = toasts(root)[0];
    fixture.componentRef.setInput('notice', { kind: 'error', text: 'A TV não está respondendo.' });
    fixture.detectChanges();
    expect(toasts(root)).toEqual([shown]);
    expect(shown.textContent?.trim()).toBe('A TV não está respondendo.');
  });

  it('shows nothing without a notice', () => {
    expect(toasts(render(null).nativeElement as HTMLElement)).toHaveLength(0);
  });
});
