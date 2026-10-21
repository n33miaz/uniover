import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, Routes, provideRouter } from '@angular/router';
import { ModuleHeadService, moduleScopeOf } from './module-head.service';

@Component({ template: '' })
class Blank {}

const ROUTES: Routes = [
  { path: '', component: Blank },
  { path: 'tv', component: Blank },
  { path: 'treino', component: Blank },
  { path: 'convite', component: Blank },
  { path: 'entrar', component: Blank },
  { path: 'atalho-da-tv', redirectTo: 'tv' },
  { path: '**', redirectTo: '' },
];

/** O que o `<head>` tem, em listas: uma duplicata aparece como um segundo item. */
function head() {
  const attrs = (selector: string, attr: string) =>
    Array.from(document.head.querySelectorAll(selector)).map((element) =>
      element.getAttribute(attr),
    );
  return {
    manifest: attrs('link[rel="manifest"]', 'href'),
    touchIcon: attrs('link[rel="apple-touch-icon"]', 'href'),
    title: document.title,
    appTitle: attrs('meta[name="apple-mobile-web-app-title"]', 'content'),
  };
}

function expected(prefix: string, name: string) {
  return {
    manifest: [`${prefix}/manifest.webmanifest`],
    touchIcon: [`${prefix}/apple-touch-icon.png`],
    title: name,
    appTitle: [name],
  };
}

const ROOT = expected('', 'UniOver');
const TV = expected('/tv', 'UniOver TV');
const TRAINING = expected('/treino', 'UniOver Treino');

/** O que o servidor entrega no lugar do marcador do index.html (e o título fixo do arquivo). */
function seedServerHead(prefix: string) {
  document.title = 'UniOver';
  for (const [rel, href] of [
    ['manifest', `${prefix}/manifest.webmanifest`],
    ['apple-touch-icon', `${prefix}/apple-touch-icon.png`],
  ]) {
    const link = document.createElement('link');
    link.setAttribute('rel', rel);
    link.setAttribute('href', href);
    document.head.appendChild(link);
  }
}

/** Abre o app no endereço dado (o servidor já teria entregue o head dele) e liga o serviço. */
function setup(path: string) {
  window.history.replaceState(null, '', path);
  TestBed.configureTestingModule({ providers: [provideRouter(ROUTES)] });
  const service = TestBed.inject(ModuleHeadService);
  service.start();
  return { service, router: TestBed.inject(Router) };
}

describe('moduleScopeOf', () => {
  it.each([
    ['/', null],
    ['', null],
    ['/tv', 'tv'],
    ['/tv/', 'tv'],
    ['/tv/qualquer/coisa', 'tv'],
    ['/treino', 'treino'],
    ['/treino/hoje', 'treino'],
    // A regra é por segmento: nome que apenas começa igual não é do módulo.
    ['/tvx', null],
    ['/tv-box', null],
    ['/treinos', null],
    ['/ajustes/tv', null],
    ['//tv', null],
    // Sem diferenciar maiúsculas, como o servidor.
    ['/TV', 'tv'],
    ['/Treino/Hoje', 'treino'],
    // Consulta e fragmento não fazem parte do caminho.
    ['/tv?aba=1', 'tv'],
    ['/tv#x', 'tv'],
    ['/convite#tv', null],
    ['/entrar?next=%2Ftv', null],
    ['/?tv', null],
    // O servidor lê o caminho já decodificado.
    ['/%74v', 'tv'],
    ['/%E0%A4%A', null],
  ])('%s belongs to %s', (path, slug) => {
    expect(moduleScopeOf(path)).toBe(slug);
  });
});

describe('ModuleHeadService', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    document.head
      .querySelectorAll(
        'link[rel="manifest"], link[rel="apple-touch-icon"], meta[name="apple-mobile-web-app-title"]',
      )
      .forEach((element) => element.remove());
    document.title = '';
  });

  it('fixes the title and the app name on a cold load of a module, keeping the server links', () => {
    seedServerHead('/tv');
    const manifest = document.head.querySelector('link[rel="manifest"]');
    const { service } = setup('/tv/');
    expect(head()).toEqual(TV);
    // Reaproveita o elemento que o servidor entregou em vez de criar outro.
    expect(document.head.querySelector('link[rel="manifest"]')).toBe(manifest);
    service.start();
    expect(head()).toEqual(TV);
  });

  it('creates what is missing when nothing injected the links (dev server)', () => {
    setup('/');
    expect(head()).toEqual(ROOT);
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('rel')).toBe(
      'manifest',
    );
  });

  it('follows root, tv, root, training without ever duplicating an element', async () => {
    seedServerHead('');
    const { router } = setup('/');
    expect(head()).toEqual(ROOT);

    await router.navigateByUrl('/tv');
    expect(head()).toEqual(TV);
    await router.navigateByUrl('/');
    expect(head()).toEqual(ROOT);
    await router.navigateByUrl('/treino');
    expect(head()).toEqual(TRAINING);
    await router.navigateByUrl('/tv');
    expect(head()).toEqual(TV);
  });

  it('puts the TV head on the invite flow: sign-up page on the root, then the TV on the same document', async () => {
    seedServerHead('');
    const { router } = setup('/convite');
    await router.navigateByUrl('/convite#segredo-do-convite');
    expect(head()).toEqual(ROOT);
    await router.navigateByUrl('/tv');
    expect(head()).toEqual(TV);
  });

  it('reads the address after redirects', async () => {
    const { router } = setup('/');
    await router.navigateByUrl('/atalho-da-tv');
    expect(router.url).toBe('/tv');
    expect(head()).toEqual(TV);
  });

  it('matches by segment: /tvx is the root, on a cold load and in the router', async () => {
    seedServerHead('');
    const { router } = setup('/tvx');
    expect(head()).toEqual(ROOT);
    await router.navigateByUrl('/tv');
    expect(head()).toEqual(TV);
    await router.navigateByUrl('/tvx');
    expect(router.url).toBe('/');
    expect(head()).toEqual(ROOT);
  });

  it('puts the root head on the sign-in page, as the server does for /entrar', async () => {
    const { router } = setup('/tv/');
    expect(head()).toEqual(TV);
    await router.navigateByUrl('/entrar?next=%2Ftv');
    expect(head()).toEqual(ROOT);
  });

  it('does not touch the head again while the scope stays the same', async () => {
    seedServerHead('');
    const { router } = setup('/');
    await router.navigateByUrl('/tv');
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.head, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Outro endereço do mesmo escopo: o roteador navega de novo, o head fica como está.
    await router.navigateByUrl('/tv?aba=1');
    expect(router.url).toBe('/tv?aba=1');
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    expect(head()).toEqual(TV);
  });

  it('listens to the router only once, however many times it is started', () => {
    TestBed.configureTestingModule({ providers: [provideRouter(ROUTES)] });
    const router = TestBed.inject(Router);
    const subscribe = vi.spyOn(router.events, 'subscribe');
    const service = TestBed.inject(ModuleHeadService);
    service.start();
    service.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('never throws when there is no usable head', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(ROUTES)] });
    const service = TestBed.inject(ModuleHeadService);
    const router = TestBed.inject(Router);
    Object.defineProperty(document, 'head', { value: null, configurable: true });
    try {
      expect(() => service.start()).not.toThrow();
      await expect(router.navigateByUrl('/treino')).resolves.toBe(true);
    } finally {
      Reflect.deleteProperty(document, 'head');
    }
  });
});
