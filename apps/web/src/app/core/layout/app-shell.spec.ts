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

  it('shows the header with the arrow back to Início and the title inside a module', async () => {
    const harness = await RouterTestingHarness.create('/mod');
    const el = root(harness);
    expect(el.querySelector('h1')?.textContent).toBe('Módulo');
    const back = el.querySelector('header a.back')!;
    expect(back.getAttribute('href')).toBe('/');
    expect(back.getAttribute('aria-label')).toBe('Voltar ao Início');
    // Só a seta: sem texto visível, e o desenho é decorativo (o nome acessível está no link).
    expect(back.textContent?.trim()).toBe('');
    expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(back.querySelectorAll('svg path').length).toBe(2);
    // Seta e título na mesma linha do cabeçalho, nessa ordem.
    expect(Array.from(el.querySelector('header')!.children).map((c) => c.tagName)).toEqual([
      'A',
      'H1',
    ]);
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

    it('has the same arrow back to Início as the owner, and the round settings button at the end', async () => {
      const harness = await RouterTestingHarness.create('/mod');
      const el = root(harness);
      expect(el.querySelector('h1')?.textContent).toBe('Módulo');
      const links = el.querySelectorAll('header a');
      expect(links).toHaveLength(2);
      const [back, settings] = Array.from(links);
      expect(back.getAttribute('href')).toBe('/');
      expect(back.getAttribute('aria-label')).toBe('Voltar ao Início');
      expect(back.querySelectorAll('svg path')).toHaveLength(2);
      expect(settings.getAttribute('href')).toBe('/ajustes');
      expect(settings.getAttribute('aria-label')).toBe('Configurações');
      expect(settings.textContent?.trim()).toBe('');
      expect(settings.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      // A seta antes do título, a engrenagem depois.
      expect(Array.from(el.querySelector('header')!.children).map((c) => c.tagName)).toEqual([
        'A',
        'H1',
        'A',
      ]);
    });

    it('uses the same round button for the arrow and for the settings (same size class)', async () => {
      const harness = await RouterTestingHarness.create('/mod');
      for (const link of Array.from(root(harness).querySelectorAll('header a'))) {
        expect(link.classList.contains('back')).toBe(true);
        expect(link.querySelectorAll('svg path').length).toBeGreaterThan(0);
      }
    });

    it('inside Ajustes there is only the arrow back to Início, not the settings button', async () => {
      const harness = await RouterTestingHarness.create('/ajustes');
      const back = root(harness).querySelector('header a')!;
      expect(back.getAttribute('href')).toBe('/');
      expect(back.getAttribute('aria-label')).toBe('Voltar ao Início');
      expect(root(harness).querySelectorAll('header a')).toHaveLength(1);
    });

    it('a screen of Ajustes goes back to the list, without the settings button', async () => {
      const harness = await RouterTestingHarness.create('/ajustes/perfil');
      const back = root(harness).querySelector('header a')!;
      expect(back.getAttribute('href')).toBe('/ajustes');
      expect(back.getAttribute('aria-label')).toBe('Voltar aos Ajustes');
      expect(root(harness).querySelectorAll('header a')).toHaveLength(1);
    });

    it.each([
      ['has only the Treino', ['module:training']],
      ['has the TV and the Treino', ['module:tv', 'module:training']],
      ['has no module', []],
    ])(
      'whatever the permissions, a guest who %s has the same arrow and button',
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
          const links = Array.from(root(harness).querySelectorAll('header a'));
          expect(links[0].getAttribute('href')).toBe('/');
          expect(links[0].getAttribute('aria-label')).toBe('Voltar ao Início');
          expect(links.length).toBe(url === '/mod' ? 2 : 1);
        }
      },
    );
  });

  describe('for the owner in Ajustes', () => {
    it('the list goes back to Início, and a screen of Ajustes goes back to the list', async () => {
      const harness = await RouterTestingHarness.create('/ajustes');
      const back = root(harness).querySelector('header a')!;
      expect(back.getAttribute('href')).toBe('/');
      expect(back.getAttribute('aria-label')).toBe('Voltar ao Início');

      await harness.navigateByUrl('/ajustes/perfil');
      const nested = root(harness).querySelector('header a')!;
      expect(nested.getAttribute('href')).toBe('/ajustes');
      expect(nested.getAttribute('aria-label')).toBe('Voltar aos Ajustes');
      expect(root(harness).querySelector('h1')?.textContent).toBe('Perfil');
    });

    it('never shows the settings button to the owner (the arrow stays, as before)', async () => {
      const harness = await RouterTestingHarness.create('/mod');
      expect(root(harness).querySelector('header a[href="/ajustes"]')).toBeNull();
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
