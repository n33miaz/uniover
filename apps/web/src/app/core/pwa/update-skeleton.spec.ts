import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Component, inject } from '@angular/core';
import { PwaUpdateService } from './pwa-update.service';
import {
  BOOT_SKELETON_ID,
  PAGE_READY_TIMEOUT_MS,
  ROUTE_WAIT_MS,
  SLOW_BOOT_MS,
  UpdateSkeleton,
} from './update-skeleton';

@Component({ template: `<div [attr.data-screen-ready]="'home'"></div>` })
class Blank {}

function addReadyMarker(value: string): void {
  const marker = document.createElement('div');
  marker.setAttribute('data-screen-ready', value);
  marker.setAttribute('data-test-screen-marker', '');
  document.body.append(marker);
}

describe('UpdateSkeleton', () => {
  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    document.querySelectorAll('[data-test-screen-marker]').forEach((element) => element.remove());
    document.documentElement.removeAttribute('data-screen-timeout');
    history.pushState({}, '', '/');
  });

  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank },
          { path: 'ok', component: Blank },
          { path: 'tv', component: Blank },
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
    expect(el.querySelector('.bs-root')).toBeNull();
  });

  it('covers the page as soon as the update starts, with an accessible label', async () => {
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    const overlay = el.querySelector('.bs-root');
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('role')).toBe('status');
    expect(overlay!.textContent).toContain('Atualizando…');
    // O desenho todo é decoração para leitores de tela: só o texto escondido fala.
    expect(overlay!.querySelector('.bs-draw')!.getAttribute('aria-hidden')).toBe('true');
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
    expect(el.querySelector('.bs-root')).toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    const overlay = el.querySelector('.bs-root');
    expect(overlay).not.toBeNull();
    expect(document.documentElement.classList.contains('has-boot-skeleton')).toBe(true);
    expect(overlay!.textContent).toContain('Carregando…');
    expect(overlay!.textContent).not.toContain('Atualizando…');
    expect(overlay!.querySelectorAll('.bone.ui-skeleton').length).toBeGreaterThan(10);

    vi.useRealTimers();
    const pending = TestBed.inject(Router).navigateByUrl('/ok');
    addReadyMarker('detail');
    await pending;
    await fixture.whenStable();
    // Sai pela animação de saída (ou já saiu): nunca fica coberto depois da primeira tela.
    await vi.waitFor(() => {
      const current = el.querySelector('.bs-root');
      expect(current === null || current.classList.contains('leaving')).toBe(true);
    });
  });

  it('does not flash the skeleton when the first screen is quick', async () => {
    vi.useFakeTimers();
    const { fixture, el } = setup();
    fixture.detectChanges();
    vi.advanceTimersByTime(SLOW_BOOT_MS - 100);
    const pending = TestBed.inject(Router).navigateByUrl('/ok');
    addReadyMarker('detail');
    await pending;
    vi.advanceTimersByTime(SLOW_BOOT_MS * 3);
    fixture.detectChanges();
    expect(el.querySelector('.bs-root')).toBeNull();
  });

  it('draws the home page (brand, hero with settings and status, module grid, no shortcuts, no tab bar) when it is the page being updated', async () => {
    history.pushState({}, '', '/');
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    expect(el.querySelector('.bs-home')).not.toBeNull();
    expect(el.querySelector('.bs-home > .bs-brand')).not.toBeNull();
    // Engrenagem e ponto de estado no cartão de cima, mais as duas linhas de texto e a hora.
    expect(el.querySelectorAll('.bs-home-hero .bs-hero-actions .bone').length).toBe(2);
    expect(el.querySelectorAll('.bs-home-hero .bone').length).toBe(5);
    expect(el.querySelector('.bs-tv-shortcuts')).toBeNull();
    expect(el.querySelectorAll('.bs-module').length).toBe(8);
    expect(el.querySelector('.bs-tabs')).toBeNull();
  });

  it('draws the TV remote exactly (header with back and menu, title, status dot and power; shortcut tiles; ring; page dots; volume, keys and channel)', async () => {
    history.pushState({}, '', '/tv/');
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    expect(el.querySelector('.bs-tv')).not.toBeNull();
    expect(el.querySelectorAll('.bs-tv-head .bs-tv-lead .bs-circle').length).toBe(2);
    expect(el.querySelectorAll('.bs-tv-head > .bs-tv-title').length).toBe(1);
    expect(el.querySelector('.bs-tv-head .bs-tv-actions .bs-state-dot')).not.toBeNull();
    expect(el.querySelectorAll('.bs-tv-head .bs-tv-actions > .bs-circle').length).toBe(1);
    expect(el.querySelectorAll('.bs-tv-shortcuts .bs-tile').length).toBe(3);
    expect(el.querySelector('.bs-ring .bs-ok')).not.toBeNull();
    expect(el.querySelectorAll('.bs-ring .bs-arrow').length).toBe(4);
    expect(el.querySelectorAll('.bs-tv-dots .bs-pip').length).toBe(3);
    expect(el.querySelectorAll('.bs-tv-bottom .bs-vpill').length).toBe(2);
    expect(el.querySelectorAll('.bs-tv-bottom .bs-round-key').length).toBe(8);
    // A TV não tem barra de abas nem o desenho genérico por baixo.
    expect(el.querySelector('.bs-tabs, .bs-generic')).toBeNull();
  });

  it('draws the training home (single top bar, today cards, three tabs) and the settings list (top bar, appearance control, two groups)', async () => {
    history.pushState({}, '', '/treino/');
    const first = setup();
    first.service.applyingUpdate.set(true);
    await first.fixture.whenStable();
    expect(first.el.querySelectorAll('.bs-training .bs-topbar').length).toBe(1);
    expect(first.el.querySelectorAll('.bs-training .bs-topbar .bs-back').length).toBe(1);
    expect(first.el.querySelectorAll('.bs-training .bs-days .bs-day').length).toBe(7);
    expect(first.el.querySelectorAll('.bs-training .bs-tabs .bs-tab').length).toBe(3);
    TestBed.resetTestingModule();

    history.pushState({}, '', '/ajustes');
    const second = setup();
    second.service.applyingUpdate.set(true);
    await second.fixture.whenStable();
    expect(second.el.querySelectorAll('.bs-settings .bs-topbar').length).toBe(1);
    expect(second.el.querySelectorAll('.bs-settings .bs-segments .bs-segment').length).toBe(3);
    expect(second.el.querySelectorAll('.bs-settings .bs-group').length).toBe(2);
    expect(second.el.querySelector('.bs-tabs')).toBeNull();
  });

  it('uses the detail drawing instead of the generic page for an unknown shell address', async () => {
    history.pushState({}, '', '/qualquer-coisa');
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    await fixture.whenStable();
    expect(el.querySelector('.bs-home, .bs-tv, .bs-training, .bs-settings, .bs-generic')).toBeNull();
    expect(el.querySelector('.bs-detail .bs-detail-cards')).not.toBeNull();
  });

  it('keeps the skeleton after the reload until the first navigation ends', async () => {
    sessionStorage.setItem('uniover.update.refreshing', String(Date.now()));
    const { service, fixture, el } = setup();
    await fixture.whenStable();
    expect(service.showSkeleton()).toBe(true);
    expect(el.querySelector('.bs-root')).not.toBeNull();

    const pending = TestBed.inject(Router).navigateByUrl('/ok');
    addReadyMarker('detail');
    await pending;
    await fixture.whenStable();
    expect(service.showSkeleton()).toBe(false);
  });

  it('treats an already finished first navigation as the first content after its marker is present', async () => {
    sessionStorage.setItem('uniover.update.refreshing', String(Date.now()));
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '', component: Blank }])],
    });
    await TestBed.inject(Router).navigateByUrl('/');
    const service = TestBed.inject(PwaUpdateService);
    expect(service.showSkeleton()).toBe(true);
    addReadyMarker('home');
    const fixture = TestBed.createComponent(UpdateSkeleton);
    await fixture.whenStable();
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
    addReadyMarker('plain');
    await TestBed.inject(Router).navigateByUrl('/privada');
    // O cancelamento do redirecionamento não derrubou o esqueleto; só o fim da navegação para /entrar.
    expect(states.slice(0, -1).every(Boolean)).toBe(true);
    expect(service.showSkeleton()).toBe(false);
  });

  it('keeps the own skeleton when navigation is cancelled or fails without a screen marker', async () => {
    for (const path of ['/cancelada', '/sumiu']) {
      sessionStorage.setItem('uniover.update.refreshing', String(Date.now()));
      TestBed.resetTestingModule();
      const { service, fixture, el } = setup();
      expect(service.showSkeleton()).toBe(true);
      await TestBed.inject(Router)
        .navigateByUrl(path)
        .catch(() => undefined);
      await fixture.whenStable();
      expect(service.showSkeleton()).toBe(true);
      expect(el.querySelector('.bs-root')).not.toBeNull();
    }
  });

  it('does not release the overlay for a mounted shell until the destination marker arrives', async () => {
    history.pushState({}, '', '/tv');
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    const pending = TestBed.inject(Router).navigateByUrl('/tv');
    await pending;
    await fixture.whenStable();
    expect(el.querySelector('.bs-root .bs-tv')).not.toBeNull();
    expect(service.showSkeleton()).toBe(true);
    addReadyMarker('home');
    await Promise.resolve();
    expect(service.showSkeleton()).toBe(true);
    addReadyMarker('tv');
    await vi.waitFor(() => expect(service.showSkeleton()).toBe(false));
  });

  it('keeps the destination skeleton and records the reason when no screen marker arrives in time', async () => {
    vi.useFakeTimers();
    history.pushState({}, '', '/tv');
    const { service, fixture, el } = setup();
    service.applyingUpdate.set(true);
    fixture.detectChanges();
    const pending = TestBed.inject(Router).navigateByUrl('/tv');
    await pending;
    vi.advanceTimersByTime(PAGE_READY_TIMEOUT_MS);
    fixture.detectChanges();
    expect(el.querySelector('.bs-root .bs-tv')).not.toBeNull();
    expect(el.querySelector('.bs-timeout')).not.toBeNull();
    expect(service.showSkeleton()).toBe(true);
    expect(document.documentElement.getAttribute('data-screen-timeout')).toBe('tv');
    expect(sessionStorage.getItem('uniover.screen-timeout')).toContain('missing-screen-marker');
  });

  it('removes the static boot skeleton from the document when the first screen is ready', async () => {
    vi.useFakeTimers();
    const boot = document.createElement('div');
    boot.id = BOOT_SKELETON_ID;
    document.body.appendChild(boot);
    const { fixture } = setup();
    fixture.detectChanges();
    expect(document.getElementById(BOOT_SKELETON_ID)).not.toBeNull();
    vi.useRealTimers();
    const pending = TestBed.inject(Router).navigateByUrl('/ok');
    addReadyMarker('detail');
    await pending;
    expect(boot.classList.contains('leaving')).toBe(true);
    await vi.waitFor(() => expect(document.getElementById(BOOT_SKELETON_ID)).toBeNull());
  });

  it('hides the static skeleton from painting while the Angular one is drawn over it', async () => {
    vi.useFakeTimers();
    const boot = document.createElement('div');
    boot.id = BOOT_SKELETON_ID;
    document.body.appendChild(boot);
    const { fixture } = setup();
    fixture.detectChanges();
    expect(boot.classList.contains('bs-covered')).toBe(false);
    vi.advanceTimersByTime(SLOW_BOOT_MS);
    fixture.detectChanges();
    expect(boot.classList.contains('bs-covered')).toBe(true);
    boot.remove();
  });

  it('covers a slow in-app navigation with the destination drawing, and only after the delay', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank },
          {
            path: 'tv',
            component: Blank,
            canActivate: [() => gate.then(() => true)],
          },
        ]),
      ],
    });
    const router = TestBed.inject(Router);
    const fixture = TestBed.createComponent(UpdateSkeleton);
    const el = fixture.nativeElement as HTMLElement;
    vi.useRealTimers();
    await router.navigateByUrl('/');
    vi.useFakeTimers();
    const pending = router.navigateByUrl('/tv');
    vi.advanceTimersByTime(ROUTE_WAIT_MS - 1);
    fixture.detectChanges();
    expect(el.querySelector('.bs-root')).toBeNull();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(el.querySelector('.bs-root .bs-tv')).not.toBeNull();
    vi.useRealTimers();
    release();
    await pending;
    addReadyMarker('tv');
    await fixture.whenStable();
    await vi.waitFor(() => {
      const current = el.querySelector('.bs-root');
      expect(current === null || current.classList.contains('leaving')).toBe(true);
    });
  });

  it('does not cover a slow query-only navigation inside the same module', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank },
          {
            path: 'tv',
            component: Blank,
            canActivate: [() => (inject(Router).url === '/' ? true : gate.then(() => true))],
          },
        ]),
      ],
    });
    const router = TestBed.inject(Router);
    const fixture = TestBed.createComponent(UpdateSkeleton);
    vi.useRealTimers();
    await router.navigateByUrl('/tv');
    vi.useFakeTimers();
    const pending = router.navigateByUrl('/tv?painel=apps');
    vi.advanceTimersByTime(ROUTE_WAIT_MS + 1);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.bs-root')).toBeNull();
    vi.useRealTimers();
    release();
    await pending;
  });
});
