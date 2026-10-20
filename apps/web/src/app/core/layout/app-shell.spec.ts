import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { AppShell } from './app-shell';

@Component({ template: '<p class="content" i18n>conteúdo</p>' })
class Content {}

const routes = [
  {
    path: '',
    component: AppShell,
    children: [
      { path: '', pathMatch: 'full' as const, component: Content },
      {
        path: 'mod',
        data: { title: 'Módulo' },
        children: [
          {
            path: '',
            component: Content,
            data: { tabs: [{ link: '/mod', label: 'Aba única' }] },
          },
        ],
      },
      { path: 'sem-abas', data: { title: 'Sem abas' }, component: Content },
    ],
  },
];

describe('AppShell', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter(routes)] }));

  const root = (harness: RouterTestingHarness) => harness.routeNativeElement as HTMLElement;

  it('shows only the content on the home route', async () => {
    const harness = await RouterTestingHarness.create('/');
    const el = root(harness);
    expect(el.querySelector('header')).toBeNull();
    expect(el.querySelector('app-tab-bar')).toBeNull();
    expect(el.querySelector('main .content')).not.toBeNull();
  });

  it('shows the header with a link to Início and the title inside a module', async () => {
    const harness = await RouterTestingHarness.create('/mod');
    const el = root(harness);
    expect(el.querySelector('h1')?.textContent).toBe('Módulo');
    expect(el.querySelector('header a')?.getAttribute('href')).toBe('/');
    expect(el.querySelector('header a')?.textContent).toContain('Início');
  });

  it('hides the way back to Início for a guest (single view, no navigation out of the TV)', async () => {
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'guest',
    });
    const harness = await RouterTestingHarness.create('/mod');
    const el = root(harness);
    expect(el.querySelector('h1')?.textContent).toBe('Módulo');
    expect(el.querySelector('header a')).toBeNull();
    localStorage.clear();
  });

  it('builds the tab bar from the route data of the module', async () => {
    const harness = await RouterTestingHarness.create('/mod');
    const links = Array.from(root(harness).querySelectorAll('app-tab-bar a'));
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Aba única']);
  });

  it('has no tab bar when the route declares no tabs, and updates when navigating', async () => {
    const harness = await RouterTestingHarness.create('/mod');
    await harness.navigateByUrl('/sem-abas');
    expect(root(harness).querySelector('app-tab-bar')).toBeNull();
    expect(root(harness).querySelector('h1')?.textContent).toBe('Sem abas');
  });
});
