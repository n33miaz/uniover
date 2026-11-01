import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
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
      {
        path: 'ajustes',
        data: { title: 'Ajustes', settings: true },
        children: [
          { path: '', pathMatch: 'full' as const, component: Content },
          {
            path: 'perfil',
            data: {
              title: 'Perfil',
              back: { link: '/ajustes', label: 'Voltar aos Ajustes' },
            },
            component: Content,
          },
        ],
      },
    ],
  },
  { path: 'boas-vindas', component: Content },
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

  const back = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('header .lead button.back');
  const settingsLink = (el: HTMLElement) => el.querySelector('header .actions a[href="/ajustes"]');

  it('shows the top bar with the arrow back to Início and the title inside a module', async () => {
    const harness = await RouterTestingHarness.create('/mod');
    const el = root(harness);
    expect(el.querySelector('h1')?.textContent).toBe('Módulo');
    const arrow = back(el)!;
    expect(arrow.getAttribute('aria-label')).toBe('Voltar ao Início');
    // Só a seta: sem texto visível, e o desenho é decorativo (o nome acessível está no botão).
    expect(arrow.textContent?.trim()).toBe('');
    expect(arrow.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(arrow.querySelectorAll('svg path').length).toBe(2);
    // Três áreas: a volta, o título no meio e as ações (vazia para o dono).
    const head = el.querySelector('header')!;
    expect(Array.from(head.children).map((c) => c.className)).toEqual(['lead', 'name', 'actions']);
    expect(head.querySelector('.actions')?.childElementCount).toBe(0);
  });

  it('goes back to Início when the arrow is pressed', async () => {
    const harness = await RouterTestingHarness.create('/mod');
    back(root(harness))!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  describe('for a guest', () => {
    beforeEach(() => {
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'A',
        role: 'guest',
      });
    });
    afterEach(() => localStorage.clear());

    it('has the same arrow back to Início as the owner, and no settings button inside a module', async () => {
      const harness = await RouterTestingHarness.create('/mod');
      const el = root(harness);
      expect(el.querySelector('h1')?.textContent).toBe('Módulo');
      expect(back(el)?.getAttribute('aria-label')).toBe('Voltar ao Início');
      expect(settingsLink(el)).toBeNull();
      expect(el.querySelector('a[href="/ajustes"]')).toBeNull();
      expect(el.querySelector('header .actions')?.childElementCount).toBe(0);
    });

    it('inside Ajustes there is only the arrow back to Início, not the settings button', async () => {
      const harness = await RouterTestingHarness.create('/ajustes');
      const el = root(harness);
      expect(back(el)?.getAttribute('aria-label')).toBe('Voltar ao Início');
      expect(settingsLink(el)).toBeNull();
    });

    it('a screen of Ajustes goes back to the list, without the settings button', async () => {
      const harness = await RouterTestingHarness.create('/ajustes/perfil');
      const el = root(harness);
      expect(back(el)?.getAttribute('aria-label')).toBe('Voltar aos Ajustes');
      expect(settingsLink(el)).toBeNull();
      back(el)!.click();
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/ajustes');
    });

    it.each([
      ['has only the Treino', ['module:training']],
      ['has the TV and the Treino', ['module:tv', 'module:training']],
      ['has no module', []],
    ])(
      'whatever the permissions, a guest who %s has the same arrow and never the settings button',
      async (_name, permissions) => {
        TestBed.inject(SessionState).setUser({
          id: '1',
          email: 'a@b.c',
          displayName: 'A',
          role: 'guest',
          permissions,
        });
        const harness = await RouterTestingHarness.create('/mod');
        for (const url of ['/mod', '/ajustes']) {
          await harness.navigateByUrl(url);
          expect(back(root(harness))?.getAttribute('aria-label')).toBe('Voltar ao Início');
          expect(settingsLink(root(harness))).toBeNull();
          expect(root(harness).querySelector('a[href="/ajustes"]')).toBeNull();
        }
      },
    );
  });

  describe('for the owner in Ajustes', () => {
    it('the list goes back to Início, and a screen of Ajustes goes back to the list', async () => {
      const harness = await RouterTestingHarness.create('/ajustes');
      expect(back(root(harness))?.getAttribute('aria-label')).toBe('Voltar ao Início');

      await harness.navigateByUrl('/ajustes/perfil');
      expect(back(root(harness))?.getAttribute('aria-label')).toBe('Voltar aos Ajustes');
      expect(root(harness).querySelector('h1')?.textContent).toBe('Perfil');
    });

    it('never shows the settings button to the owner either (the arrow stays, as before)', async () => {
      const harness = await RouterTestingHarness.create('/mod');
      expect(settingsLink(root(harness))).toBeNull();
    });

    it('marks the main area of Ajustes, so the cards take the corner of the TV cards', async () => {
      const harness = await RouterTestingHarness.create('/ajustes');
      expect(root(harness).querySelector('main')?.classList.contains('settings-main')).toBe(true);
      await harness.navigateByUrl('/mod');
      expect(root(harness).querySelector('main')?.classList.contains('settings-main')).toBe(false);
    });

    it('moves the focus to the title when going between Ajustes screens, so keyboard and screen reader land on the new one', async () => {
      const harness = await RouterTestingHarness.create('/ajustes');
      await harness.navigateByUrl('/ajustes/perfil');
      await harness.fixture.whenStable();
      await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
      expect(document.activeElement?.textContent).toBe('Perfil');
    });

    it('leaves the focus alone outside Ajustes and on the first screen', async () => {
      const harness = await RouterTestingHarness.create('/ajustes');
      await harness.fixture.whenStable();
      expect(document.activeElement?.tagName).not.toBe('H1');
      await harness.navigateByUrl('/mod');
      await harness.fixture.whenStable();
      expect(document.activeElement?.tagName).not.toBe('H1');
    });
  });

  describe('first access safety net', () => {
    it('asks for the name when the user only arrives after the shell opened, remembering the screen', async () => {
      const harness = await RouterTestingHarness.create('/ajustes/perfil');
      expect(TestBed.inject(Router).url).toBe('/ajustes/perfil');
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'a',
        role: 'owner',
        displayNameConfirmed: false,
      });
      await harness.fixture.whenStable();
      await vi.waitFor(() =>
        expect(TestBed.inject(Router).url).toBe('/boas-vindas?next=%2Fajustes%2Fperfil'),
      );
    });

    it('does nothing for a user who already chose the name, or for one the server did not describe', async () => {
      const harness = await RouterTestingHarness.create('/mod');
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'A',
        role: 'owner',
        displayNameConfirmed: true,
      });
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/mod');
      TestBed.inject(SessionState).setUser({ id: '1', email: 'a@b.c', displayName: 'A' });
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/mod');
    });
  });

  it('hosts the shortcut sheet outside the content, so it never enters the layout of a screen', async () => {
    const harness = await RouterTestingHarness.create('/mod');
    const el = root(harness);
    const hint = el.querySelector('app-install-hint');
    expect(hint).not.toBeNull();
    expect(el.querySelector('main')?.contains(hint)).toBe(false);
    // Fechada, não desenha nada: a tela não ganha elemento algum.
    expect(hint?.children).toHaveLength(0);
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
