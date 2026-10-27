import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Component, inject } from '@angular/core';
import { PwaUpdateService } from './pwa-update.service';
import { UpdateSkeleton } from './update-skeleton';

@Component({ template: '' })
class Blank {}

describe('UpdateSkeleton', () => {
  afterEach(() => sessionStorage.clear());

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
