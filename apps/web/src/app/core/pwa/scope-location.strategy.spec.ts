import { Location, LocationStrategy, PlatformLocation } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, RouterLink, provideRouter } from '@angular/router';
import { ScopePathLocationStrategy, withScopeSlash } from './scope-location.strategy';

@Component({ template: '' })
class Blank {}

@Component({
  imports: [RouterLink],
  template: `<a routerLink="/tv" i18n>TV</a><a routerLink="/treino" i18n>Treino</a
    ><a routerLink="/" i18n>Início</a>`,
})
class Links {}

describe('withScopeSlash', () => {
  it.each([
    ['/tv', '/tv/'],
    ['/treino', '/treino/'],
    ['/pc', '/pc/'],
    ['/tv?painel=apps', '/tv/?painel=apps'],
    ['/pc#x', '/pc/#x'],
    ['/tv/', '/tv/'],
    ['/tv/livre', '/tv/livre'],
    ['/pc/atalhos?x=1', '/pc/atalhos?x=1'],
    ['/tvx', '/tvx'],
    ['/', '/'],
    ['/ajustes/tv', '/ajustes/tv'],
  ])('%s -> %s', (input, output) => {
    expect(withScopeSlash(input)).toBe(output);
  });
});

describe('ScopePathLocationStrategy', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank },
          { path: 'tv', component: Blank },
          { path: 'treino', component: Blank },
          { path: 'tv/livre', component: Blank },
        ]),
        { provide: LocationStrategy, useClass: ScopePathLocationStrategy },
      ],
    });
  });

  afterEach(() => history.replaceState(null, '', '/'));

  it('writes the module root inside the installed app scope, while the router keeps seeing /tv', async () => {
    // O TestBed do Angular 22 usa uma navegação falsa por padrão: o endereço escrito é o dela, não o do jsdom.
    const router = TestBed.inject(Router);
    const location = TestBed.inject(PlatformLocation);
    await router.navigateByUrl('/tv?painel=apps');
    expect(location.pathname).toBe('/tv/');
    expect(location.search).toBe('?painel=apps');
    expect(TestBed.inject(Location).path()).toBe('/tv?painel=apps');
    expect(router.url).toBe('/tv?painel=apps');

    await router.navigateByUrl('/tv/livre');
    expect(location.pathname).toBe('/tv/livre');
    await router.navigateByUrl('/');
    expect(location.pathname).toBe('/');
  });

  it('gives links to a module root the trailing slash', async () => {
    const fixture = TestBed.createComponent(Links);
    fixture.detectChanges();
    await fixture.whenStable();
    const hrefs = [...(fixture.nativeElement as HTMLElement).querySelectorAll('a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual(['/tv/', '/treino/', '/']);
  });
});
