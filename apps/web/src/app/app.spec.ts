import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
  // O armazenamento é dividido entre os arquivos do mesmo trabalhador: dicas de conta de outros testes mudariam o tema lido.
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('creates the root with banners and a router outlet', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('router-outlet')).not.toBeNull();
    expect(el.querySelector('app-update-banner')).not.toBeNull();
    expect(el.querySelector('app-connectivity-banner')).not.toBeNull();
    expect(el.querySelector('app-session-notice')).not.toBeNull();
  });

  it('applies the saved theme preference from the first frame', async () => {
    localStorage.setItem('uniover.theme.v1', 'dark');
    document.documentElement.removeAttribute('data-theme');
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.createComponent(App);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    localStorage.clear();
  });
});
