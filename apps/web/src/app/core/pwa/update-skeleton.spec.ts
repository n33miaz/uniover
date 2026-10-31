import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Component, inject } from '@angular/core';
import { PwaUpdateService } from './pwa-update.service';
import { SLOW_BOOT_MS, UpdateSkeleton } from './update-skeleton';

@Component({ template: '' })
class Blank {}

describe('UpdateSkeleton', () => {
  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    history.pushState({}, '', '/');
  });

  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank },
          { path: 'ok', component: Blank },
          { path: 'cancelada', component: Blank, canActivate: [() => false] },
          {
            path: 'sumiu',
            loadComponent: () => Promise.reject(new Error('falhou')),
          },
        ]),
      ],
    });
    const service = TestBed.inject(PwaUpdateService);
    const fixture = TestBed.createComponent(UpdateSkeleton);
    return { service, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('stays out of the way until an update starts', async () => {
    const { fixture, el } = setup();
    await fixture.whenStable();
    expect(el.querySelector('.overlay')).toBeNull();
  });

  it('covers the page as soon as the update starts, with an accessible label', async () => {
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    const overlay = el.querySelector('.overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('role')).toBe('status');
    expect(overlay!.textContent).toContain('Atualizando…');
    // O desenho todo é decoração para leitores de tela: só o texto escondido fala.
    expect(overlay!.querySelector('.page')!.getAttribute('aria-hidden')).toBe('true');
    expect(overlay!.querySelectorAll('.bone').length).toBeGreaterThan(10);
  });

  it('uses the one shared waiting shimmer on every bone, so the update looks like every other wait', async () => {
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    const bones = Array.from(el.querySelectorAll('.bone'));
    expect(bones.length).toBeGreaterThan(10);
    expect(bones.every((bone) => bone.classList.contains('ui-skeleton'))).toBe(true);
  });

  it('covers a slow opening (first screen still pending) and lets go when the screen arrives', async () => {
    vi.useFakeTimers();
    const { fixture, el } = setup();
    fixture.detectChanges();
    vi.advanceTimersByTime(SLOW_BOOT_MS - 1);
    fixture.detectChanges();
    expect(el.querySelector('.overlay')).toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    const overlay = el.querySelector('.overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('Carregando…');
    expect(overlay!.textContent).not.toContain('Atualizando…');
    expect(overlay!.querySelectorAll('.bone.ui-skeleton').length).toBeGreaterThan(10);

    vi.useRealTimers();
    await TestBed.inject(Router).navigateByUrl('/ok');
    await fixture.whenStable();
    // Sai pela animação de saída (ou já saiu): nunca fica coberto depois da primeira tela.
    await vi.waitFor(() => {
      const current = el.querySelector('.overlay');
      expect(current === null || current.classList.contains('leaving')).toBe(true);
    });
  });

  it('does not flash the skeleton when the first screen is quick', async () => {
    vi.useFakeTimers();
    const { fixture, el } = setup();
    fixture.detectChanges();
    vi.advanceTimersByTime(SLOW_BOOT_MS - 100);
    await TestBed.inject(Router).navigateByUrl('/ok');
    vi.advanceTimersByTime(SLOW_BOOT_MS * 3);
    fixture.detectChanges();
    expect(el.querySelector('.overlay')).toBeNull();
  });

  it('draws the home page (brand, hero with settings and status, module grid, no shortcuts, no tab bar) when it is the page being updated', async () => {
    history.pushState({}, '', '/');
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    expect(el.querySelector('.page.home')).not.toBeNull();
    expect(el.querySelector('.page.home > .brand')).not.toBeNull();
    // Engrenagem e ponto de estado no cartão de cima, mais as duas linhas de texto e a hora.
    expect(el.querySelectorAll('.home-hero .hero-actions .bone').length).toBe(2);
    expect(el.querySelectorAll('.home-hero .bone').length).toBe(5);
    expect(el.querySelector('.shortcuts, .shortcut')).toBeNull();
    expect(el.querySelectorAll('.module').length).toBe(8);
    expect(el.querySelector('.tabs')).toBeNull();
  });

  it('keeps the generic page drawing (header, cards, list, tab bar) for any other route', async () => {
    history.pushState({}, '', '/tv');
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    expect(el.querySelector('.page.home')).toBeNull();
    expect(el.querySelector('.tabs')).not.toBeNull();
    expect(el.querySelector('.top')).not.toBeNull();
  });

  it('keeps the skeleton after the reload until the first navigation ends', async () => {
    sessionStorage.setItem('uniover.update.refreshing', String(Date.now()));
    const { service, fixture, el } = setup();
    await fixture.whenStable();
    expect(service.showSkeleton()).toBe(true);
    expect(el.querySelector('.overlay')).not.toBeNull();

    await TestBed.inject(Router).navigateByUrl('/ok');
    await fixture.whenStable();
    expect(service.showSkeleton()).toBe(false);
  });

  it('treats an already finished first navigation as the first content', async () => {
    sessionStorage.setItem('uniover.update.refreshing', String(Date.now()));
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '', component: Blank }])],
    });
    await TestBed.inject(Router).navigateByUrl('/');
    const service = TestBed.inject(PwaUpdateService);
    expect(service.showSkeleton()).toBe(true);
    TestBed.createComponent(UpdateSkeleton);
    expect(service.showSkeleton()).toBe(false);
  });

  it('keeps the skeleton when a guard redirects, until the navigation it started ends', async () => {
    sessionStorage.setItem('uniover.update.refreshing', String(Date.now()));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank },
          {
            path: 'privada',
            component: Blank,
            canActivate: [() => inject(Router).parseUrl('/entrar')],
          },
          { path: 'entrar', component: Blank },
        ]),
      ],
    });
    const service = TestBed.inject(PwaUpdateService);
    TestBed.createComponent(UpdateSkeleton);
    const states: boolean[] = [];
    TestBed.inject(Router).events.subscribe(() => states.push(service.showSkeleton()));
    await TestBed.inject(Router).navigateByUrl('/privada');
    // O cancelamento do redirecionamento não derrubou o esqueleto; só o fim da navegação para /entrar.
    expect(states.slice(0, -1).every(Boolean)).toBe(true);
    expect(service.showSkeleton()).toBe(false);
  });

  it('lets go when the navigation is cancelled or fails (the error handler takes over from there)', async () => {
    for (const path of ['/cancelada', '/sumiu']) {
      sessionStorage.setItem('uniover.update.refreshing', String(Date.now()));
      TestBed.resetTestingModule();
      const { service } = setup();
      expect(service.showSkeleton()).toBe(true);
      await TestBed.inject(Router)
        .navigateByUrl(path)
        .catch(() => undefined);
      expect(service.showSkeleton()).toBe(false);
    }
  });
});
