/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SETTINGS_ROUTES } from '../../settings.routes';
import { TRAINING_ROUTES } from '../../modules/training/training.routes';
import { BootVariant, bootVariantFor } from './boot-variant';
import { PwaUpdateService } from './pwa-update.service';
import { UpdateSkeleton } from './update-skeleton';

@Component({ template: '' })
class Blank {}

// Os testes rodam a partir de apps/web.
const INDEX = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
const BOOT_CSS = readFileSync(resolve(process.cwd(), 'src/boot-skeleton.css'), 'utf8');
const BOOT_SELECTOR = readFileSync(resolve(process.cwd(), 'public/boot-skeleton.js'), 'utf8');

// A tabela é de todos os que escolhem o desenho (este script, bootVariantFor e o BootVariants.cs da API).
const TABLE: { cases: { path: string; variant: BootVariant }[] } = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../contracts/boot-variants.json'), 'utf8'),
);
// O roteador do Angular também passa a query e o hash a bootVariantFor.
const CASES: readonly (readonly [string, BootVariant])[] = [
  ...TABLE.cases.map((entry) => [entry.path, entry.variant] as const),
  ['/tv?painel=apps', 'tv'],
  ['/tv#topo', 'tv'],
];

/** O que o seletor inicial marca na raiz para um endereço (ele roda sem Angular, então aqui é executado à parte). */
function runBootSelector(pathname: string): string | null {
  let marked: string | null = null;
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        if (name === 'data-boot') marked = value;
      },
    },
    getElementById: () => null,
    addEventListener: () => undefined,
    querySelector: () => null,
  };
  new Function('location', 'document', 'setTimeout', BOOT_SELECTOR)(
    { pathname, reload: () => undefined },
    document,
    () => 0,
  );
  return marked;
}

/** Uma folha de estilos marcada, como o passo de build a deixa: com media="print" até o script ligá-la. */
function runBootStyles(
  loaded: boolean | 'empty' | 'denied',
  options: {
    entries?: { responseEnd: number }[];
    registration?: { update(): Promise<void> } | null;
  } = {},
) {
  const listeners: Record<string, () => void> = {};
  const clicks: ((event: { target: { id: string } }) => void)[] = [];
  const timers: (() => void)[] = [];
  const attributes: Record<string, string> = {};
  const events: string[] = [];
  const reloads: string[] = [];
  const skeleton = {
    marks: {} as Record<string, string>,
    setAttribute: (name: string, value: string) => (skeleton.marks[name] = value),
  };
  const notice = { hidden: true };
  const sheet = {
    media: 'print',
    href: 'http://x/styles-TESTE.css',
    sheet:
      loaded === 'denied'
        ? Object.defineProperty({}, 'cssRules', {
            get: () => {
              throw new Error('SecurityError');
            },
          })
        : loaded === 'empty'
          ? { cssRules: [] }
          : loaded
            ? { cssRules: [{}] }
            : null,
    addEventListener: (name: string, listener: () => void) => (listeners[name] = listener),
  };
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => (attributes[name] = value),
      getAttribute: (name: string) => attributes[name] ?? null,
    },
    getElementById: (id: string) =>
      id === 'boot-skeleton' ? skeleton : id === 'boot-timeout' ? notice : null,
    addEventListener: (name: string, handler: (event: { target: { id: string } }) => void) => {
      if (name === 'click') clicks.push(handler);
    },
    querySelector: (selector: string) => (selector === 'link[data-boot-styles]' ? sheet : null),
    dispatchEvent: (event: Event) => events.push(event.type),
  };
  const registration = options.registration === undefined ? null : options.registration;
  const navigator = {
    serviceWorker: { getRegistration: () => Promise.resolve(registration) },
  };
  new Function(
    'location',
    'document',
    'setTimeout',
    'Event',
    'performance',
    'navigator',
    BOOT_SELECTOR,
  )(
    { pathname: '/', reload: () => reloads.push('reload') },
    document,
    (callback: () => void) => timers.push(callback),
    Event,
    { getEntriesByName: () => options.entries ?? [] },
    navigator,
  );
  return { sheet, listeners, attributes, events, skeleton, notice, timers, clicks, reloads };
}

/** A forma de uma árvore: tag e classes (ordenadas), sem texto, comentários nem atributos do Angular. */
function shape(element: Element): string {
  const classes = Array.from(element.classList)
    .filter((name) => !name.startsWith('ng-'))
    .sort()
    .join('.');
  const children = Array.from(element.children).map(shape).join(',');
  return `${element.tagName.toLowerCase()}.${classes}(${children})`;
}

describe('boot skeleton', () => {
  afterEach(() => history.pushState({}, '', '/'));

  it('picks the drawing for every address', () => {
    for (const [path, variant] of CASES) expect(bootVariantFor(path), path).toBe(variant);
  });

  it('is chosen by the pre-Angular script with the very same rule', () => {
    for (const [path, variant] of CASES) {
      // O script só lê o caminho: a query e o hash não chegam a ele.
      const pathname = path.split(/[?#]/, 1)[0];
      expect(runBootSelector(pathname), path).toBe(variant);
    }
  });

  it('covers in the shared table every drawing the pre-Angular script can choose', () => {
    const chosen = new Set([...BOOT_SELECTOR.matchAll(/\bv = '([\w-]+)'/g)].map((m) => m[1]));
    const listed = new Set(TABLE.cases.map((entry) => entry.variant));
    expect(chosen.size).toBeGreaterThan(30);
    for (const variant of chosen) expect(listed.has(variant as BootVariant), variant).toBe(true);
  });

  it('overwrites the drawing the server already wrote (the service worker serves the "/" page everywhere)', () => {
    const attributes: Record<string, string> = { 'data-boot': 'home' };
    const document = {
      documentElement: {
        setAttribute: (name: string, value: string) => (attributes[name] = value),
      },
      getElementById: () => null,
      addEventListener: () => undefined,
      querySelector: () => null,
    };
    new Function('location', 'document', 'setTimeout', BOOT_SELECTOR)(
      { pathname: '/tv', reload: () => undefined },
      document,
      () => 0,
    );
    expect(attributes['data-boot']).toBe('tv');
  });

  it('sits beside app-root with the nonce-protected first-paint styles', () => {
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    const boot = doc.getElementById('boot-skeleton');
    expect(boot).not.toBeNull();
    expect(boot!.parentElement).toBe(doc.body);
    expect(doc.querySelector('app-root')!.contains(boot)).toBe(false);
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('src')).toBe('boot-skeleton.js');
    expect(scripts[0].hasAttribute('defer')).toBe(true);
    expect(BOOT_SELECTOR).toContain("document.documentElement.setAttribute('data-boot', v)");
    expect(doc.head.contains(scripts[0])).toBe(true);
    const critical = doc.querySelector('style[nonce="__CSP_NONCE__"]');
    expect(critical).not.toBeNull();
    expect(critical!.textContent).toContain('.bs-root');
    expect(critical!.textContent).toContain('html:not([data-boot]) .bs-home');
    expect(boot!.getAttribute('aria-hidden')).toBe('true');
  });

  it('turns the deferred stylesheet on and tells the app when it loads', () => {
    const run = runBootStyles(false);
    expect(run.attributes['data-styles']).toBe('pending');
    expect(run.sheet.media).toBe('print');
    expect(run.events).toEqual([]);
    run.sheet.sheet = { cssRules: [{}] };
    run.listeners['load']();
    expect(run.sheet.media).toBe('all');
    expect(run.attributes['data-styles']).toBe('ready');
    expect(run.events).toEqual(['uniover:styles-ready']);
    // Um segundo aviso não repete o evento.
    run.listeners['load']();
    expect(run.events).toHaveLength(1);
  });

  it('keeps the skeleton and offers a retry at once when the stylesheet fails, instead of showing the page unstyled', () => {
    sessionStorage.removeItem('uniover.boot-styles-failures');
    const run = runBootStyles(false);
    expect(run.attributes['data-styles-owner']).toBe('boot');
    expect(run.notice.hidden).toBe(true);
    run.listeners['error']();
    expect(run.attributes['data-styles']).toBe('pending');
    expect(run.sheet.media).toBe('print');
    expect(run.events).toEqual([]);
    expect(run.skeleton.marks['data-boot-timeout']).toBe('true');
    expect(run.notice.hidden).toBe(false);
    expect(sessionStorage.getItem('uniover.boot-styles-failures')).toBe('1');
    sessionStorage.removeItem('uniover.boot-styles-failures');
  });

  it('lets the app through unstyled on the second failure in a row, so the retry does not loop forever on a stale page', () => {
    sessionStorage.setItem('uniover.boot-styles-failures', '1');
    const run = runBootStyles(false);
    run.listeners['error']();
    expect(run.attributes['data-styles']).toBe('ready');
    expect(run.sheet.media).toBe('all');
    expect(run.events).toEqual(['uniover:styles-ready']);
    expect(run.notice.hidden).toBe(true);
    expect(sessionStorage.getItem('uniover.boot-styles-failures')).toBe('2');
    sessionStorage.removeItem('uniover.boot-styles-failures');
  });

  it('forgets the failures when the stylesheet loads', () => {
    sessionStorage.setItem('uniover.boot-styles-failures', '1');
    const run = runBootStyles(false);
    run.sheet.sheet = { cssRules: [{}] };
    run.listeners['load']();
    expect(sessionStorage.getItem('uniover.boot-styles-failures')).toBeNull();
  });

  it('notices a stylesheet that had already failed before the listeners existed, without waiting for the 20 s cap', () => {
    sessionStorage.removeItem('uniover.boot-styles-failures');
    const run = runBootStyles(false, { entries: [{ responseEnd: 120 }] });
    expect(run.notice.hidden).toBe(true);
    // O primeiro prazo curto confere o registro de recursos; o último (20 s) é o teto geral.
    run.timers[0]();
    expect(run.notice.hidden).toBe(false);
    expect(run.attributes['data-styles']).toBe('pending');
    sessionStorage.removeItem('uniover.boot-styles-failures');
  });

  it('counts one failure once, even when both the event and the resource check report it', () => {
    sessionStorage.removeItem('uniover.boot-styles-failures');
    const run = runBootStyles(false, { entries: [{ responseEnd: 120 }] });
    run.listeners['error']();
    run.timers[0]();
    expect(run.attributes['data-styles']).toBe('pending');
    expect(run.notice.hidden).toBe(false);
    expect(sessionStorage.getItem('uniover.boot-styles-failures')).toBe('1');
    sessionStorage.removeItem('uniover.boot-styles-failures');
  });

  it('treats the sheet that WebKit gives to a failed load (empty, or with unreadable rules) as a failure at once', () => {
    for (const kind of ['empty', 'denied'] as const) {
      sessionStorage.removeItem('uniover.boot-styles-failures');
      const run = runBootStyles(kind);
      expect(run.attributes['data-styles'], kind).toBe('pending');
      expect(run.sheet.media, kind).toBe('print');
      expect(run.notice.hidden, kind).toBe(false);
      expect(run.events, kind).toEqual([]);
    }
    sessionStorage.removeItem('uniover.boot-styles-failures');
  });

  it('does not call a stylesheet that is still loading a failure', () => {
    const run = runBootStyles(false, { entries: [] });
    run.timers[0]();
    expect(run.notice.hidden).toBe(true);
  });

  it('asks the service worker for a new version before reloading on retry', async () => {
    const update = vi.fn(() => Promise.resolve());
    const run = runBootStyles(false, { registration: { update } });
    run.clicks[0]({ target: { id: 'boot-timeout-retry' } });
    await vi.waitFor(() => expect(run.reloads).toEqual(['reload']));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('reloads straight away on retry when there is no service worker registration', async () => {
    const run = runBootStyles(false, { registration: null });
    run.clicks[0]({ target: { id: 'boot-timeout-retry' } });
    await vi.waitFor(() => expect(run.reloads).toEqual(['reload']));
  });

  it('turns the stylesheet on at once when it was already loaded, and leaves no mark without a deferred one', () => {
    const run = runBootStyles(true);
    expect(run.sheet.media).toBe('all');
    expect(run.attributes['data-styles']).toBe('ready');
    expect(run.events).toEqual(['uniover:styles-ready']);
    expect(Object.keys(run.listeners)).toEqual([]);
    expect(runBootSelector('/')).toBe('home');
  });

  it('keeps the static drawing visible and offers a retry when the app does not start', () => {
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    expect(BOOT_SELECTOR).toContain("el.setAttribute('data-boot-timeout', 'true')");
    expect(BOOT_SELECTOR).toContain('location.reload()');
    expect(doc.getElementById('boot-timeout')?.getAttribute('role')).toBe('alert');
    expect(doc.getElementById('boot-timeout-retry')?.tagName).toBe('BUTTON');
    expect(BOOT_CSS).not.toContain('.bs-root.bs-stale');
  });

  const VARIANTS: readonly (readonly [BootVariant, string, string?])[] = [
    ['home', '/'],
    ['tv', '/tv/'],
    ['pc', '/pc', 'detail'],
    ['training-today', '/treino/', 'training'],
    ['training-session', '/treino/sessao', 'training'],
    ['training-session-exercise', '/treino/sessao/exercicio', 'training'],
    ['training-glossary', '/treino/glossario', 'training'],
    ['training-library', '/treino/exercicios', 'training'],
    ['training-exercise-form', '/treino/exercicios/novo', 'training'],
    ['training-map', '/treino/exercicios/mapa', 'training'],
    ['training-exercise-detail', '/treino/exercicios/item', 'training'],
    ['training-routines', '/treino/rotinas', 'training'],
    ['training-routine-editor', '/treino/rotinas/nova', 'training'],
    ['training-progress', '/treino/progresso', 'training'],
    ['training-food', '/treino/alimentacao', 'training'],
    ['training-body', '/treino/corpo', 'training'],
    ['training-assessments', '/treino/corpo/avaliacoes', 'training'],
    ['training-assessment-import', '/treino/corpo/avaliacoes/importar', 'training'],
    ['training-assessment-editor', '/treino/corpo/avaliacoes/nova', 'training'],
    ['training-assessment-detail', '/treino/corpo/avaliacoes/item', 'training'],
    ['settings', '/ajustes'],
    ['settings-system', '/ajustes/sistema', 'detail'],
    ['settings-people', '/ajustes/pessoas', 'detail'],
    ['settings-security', '/ajustes/seguranca', 'detail'],
    ['settings-siri', '/ajustes/seguranca/siri', 'detail'],
    ['settings-tv-people', '/ajustes/tvs-por-pessoa', 'detail'],
    ['settings-tv-history', '/ajustes/tv/item/historico', 'detail'],
    ['settings-audit', '/ajustes/auditoria', 'detail'],
    ['settings-devices', '/ajustes/dispositivos', 'detail'],
    ['settings-profile', '/ajustes/perfil', 'detail'],
    ['settings-appearance', '/ajustes/aparencia', 'detail'],
    ['settings-about', '/ajustes/sobre', 'detail'],
    ['settings-credits', '/ajustes/sobre/creditos', 'detail'],
    ['auth-login', '/entrar', 'plain'],
    ['auth-recovery', '/recuperar-senha', 'plain'],
    ['auth-reset', '/redefinir-senha', 'plain'],
    ['auth-qr', '/entrar/qr', 'plain'],
    ['auth-invite', '/convite', 'plain'],
    ['auth-welcome', '/boas-vindas', 'plain'],
    ['devices-connect', '/conectar', 'plain'],
  ];

  for (const [variant, path, mappedDrawing] of VARIANTS) {
    it(`draws the ${variant} skeleton with the same shapes in index.html and in the Angular overlay`, async () => {
      expect(bootVariantFor(path), path).toBe(variant);
      expect(runBootSelector(path), path).toBe(variant);
      history.pushState({}, '', path);
      TestBed.configureTestingModule({
        providers: [provideRouter([{ path: '**', component: Blank }])],
      });
      const service = TestBed.inject(PwaUpdateService);
      const fixture = TestBed.createComponent(UpdateSkeleton);
      service.applyingUpdate.set(true);
      await fixture.whenStable();
      const angular = (fixture.nativeElement as HTMLElement).querySelector('.bs-root .bs-draw');
      const doc = new DOMParser().parseFromString(INDEX, 'text/html');
      const drawing = mappedDrawing ?? variant;
      const stat = doc.querySelector(`#boot-skeleton > .bs-variant.bs-${drawing}`);
      expect(angular, 'overlay').not.toBeNull();
      expect(stat, 'static').not.toBeNull();
      expect(shape(angular!)).toBe(shape(stat!));
    });
  }

  it('never selects the generic drawing outside an entry route', () => {
    for (const [path] of CASES) {
      if (!/^\/(entrar|convite|boas-vindas|conectar)(\/|$)/.test(path)) {
        expect(bootVariantFor(path), path).not.toBe('generic');
        expect(runBootSelector(path.split(/[?#]/, 1)[0]), path).not.toBe('generic');
      }
    }
  });

  it('covers the routes declared by the shell instead of relying only on a hand-written address list', () => {
    const expectedSettings: Readonly<Record<string, BootVariant>> = {
      '': 'settings',
      perfil: 'settings-profile',
      aparencia: 'settings-appearance',
      seguranca: 'settings-security',
      'seguranca/siri': 'settings-siri',
      pessoas: 'settings-people',
      'tvs-por-pessoa': 'settings-tv-people',
      'tv/:id/historico': 'settings-tv-history',
      auditoria: 'settings-audit',
      sistema: 'settings-system',
      dispositivos: 'settings-devices',
      aparelhos: 'settings-devices',
      sobre: 'settings-about',
      creditos: 'settings-credits',
    };
    const actualSettings = SETTINGS_ROUTES.filter((route) => route.path !== undefined).map(
      (route) => route.path!,
    );
    expect(Object.keys(expectedSettings).sort()).toEqual(actualSettings.sort());
    for (const path of actualSettings) {
      const address = `/ajustes/${path.replace(':id', 'uma-tv')}`.replace(/\/$/, '');
      expect(bootVariantFor(address), address).toBe(expectedSettings[path]);
    }

    const trainingChildren = TRAINING_ROUTES[0].children ?? [];
    for (const route of trainingChildren) {
      if (!route.path) continue;
      const address = `/treino/${route.path.replace(/:id/g, 'item')}`;
      expect(bootVariantFor(address), address).toMatch(/^training-/);
    }
  });

  it('releases entry-page coverage when each destination mounts', () => {
    const pages: readonly (readonly [string, string])[] = [
      ['core/auth/login.page.html', 'auth-login'],
      ['core/auth/qr/qr-approve.page.html', 'auth-qr'],
      ['core/auth/accept-invite.page.html', 'auth-invite'],
      ['core/auth/welcome.page.html', 'auth-welcome'],
      ['modules/devices/connect.page.html', 'devices-connect'],
    ];
    for (const [file, variant] of pages) {
      const html = readFileSync(resolve(process.cwd(), 'src/app', file), 'utf8');
      expect(html, file).toContain(`[attr.data-screen-ready]="'${variant}'"`);
    }
    for (const [file, variant] of [
      ['core/auth/request-recovery.page.ts', 'auth-recovery'],
      ['core/auth/reset-password.page.ts', 'auth-reset'],
    ] as const) {
      const source = readFileSync(resolve(process.cwd(), 'src/app', file), 'utf8');
      expect(source, file).toContain(`[attr.data-screen-ready]="'${variant}'"`);
    }
  });

  it('keeps a distinct visible composition for each training and settings destination', () => {
    for (const [variant] of VARIANTS.filter(
      ([name]) => name !== 'home' && name !== 'tv' && name !== 'settings',
    )) {
      expect(BOOT_CSS).toContain(`data-boot='${variant}'`);
      expect(BOOT_CSS).toContain(`data-boot-variant='${variant}'`);
    }
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    const training = doc.querySelector('.bs-training')!;
    expect(training.querySelector('.bs-training-today-content .bs-hero')).not.toBeNull();
    expect(training.querySelector('.bs-route-content .bs-route-head')).not.toBeNull();
    expect(training.querySelector('.bs-route-content .bs-route-grid')).not.toBeNull();
    expect(training.querySelector('.bs-route-content .bs-route-panel')).not.toBeNull();
    expect(training.querySelectorAll('.bs-training-progress-content .bs-segment')).toHaveLength(2);
    expect(training.querySelector('.bs-training-progress-content .bs-chart-line')).not.toBeNull();
    expect(training.querySelector('.bs-training-body-content .bs-body-title')).not.toBeNull();
    expect(training.querySelectorAll('.bs-training-body-content .bs-segment')).toHaveLength(3);
    expect(training.querySelector('.bs-training-body-content .bs-weight-card')).not.toBeNull();
    expect(training.querySelectorAll('.bs-training-body-content .bs-signal-card')).toHaveLength(2);
    expect(training.querySelector('.bs-training-body-content .bs-map-panel')).not.toBeNull();
    const detail = doc.querySelector('.bs-detail')!;
    expect(detail.querySelector('.bs-settings-data-content .bs-row')).not.toBeNull();
    expect(detail.querySelectorAll('.bs-settings-system-content .bs-section-label')).toHaveLength(
      4,
    );
    expect(
      detail.querySelectorAll('.bs-settings-system-content .bs-system-metrics .bs-card'),
    ).toHaveLength(4);
    expect(detail.querySelector('.bs-settings-profile-content > .bs-section-label')).not.toBeNull();
    expect(detail.querySelector('.bs-settings-profile-content .bs-identity')).not.toBeNull();
    expect(detail.querySelector('.bs-settings-profile-content .bs-identity-who')).not.toBeNull();
    expect(
      detail.querySelectorAll('.bs-settings-appearance-content .bs-theme-choice'),
    ).toHaveLength(3);
    expect(detail.querySelector('.bs-route-content .bs-route-list')).not.toBeNull();
  });

  it('uses the real list, sheet and form structures for the destinations that do not have tabs or card grids', () => {
    // O formatador quebra as listas de seletores em várias linhas: compara sem depender das quebras.
    const css = BOOT_CSS.replace(/\s+/g, ' ');
    // Alguma regra cujo seletor cita a variante e termina no alvo, sem atravessar o corpo de outra regra.
    const targets = (variant: string, tail: string): boolean =>
      css.split('}').some((rule) => {
        const selector = rule.slice(0, rule.indexOf('{'));
        return selector.includes("data-boot='" + variant + "'") && selector.trim().endsWith(tail);
      });
    expect(targets('training-food', '.bs-route-list')).toBe(true);
    expect(targets('training-glossary', '.bs-route-strip')).toBe(true);
    expect(targets('training-assessments', '.bs-route-strip')).toBe(true);
    // Rotinas desenha o seletor Catálogo | Rotinas dentro da própria rota, não pela faixa genérica.
    expect(targets('training-routines', '.bs-route-strip')).toBe(false);
    expect(targets('settings-about', '.bs-route-about')).toBe(true);
    expect(targets('training-assessments', '.bs-route-assess')).toBe(true);
    expect(targets('training-routines', '.bs-route-routines')).toBe(true);
    expect(targets('settings-security', '.bs-route-hero')).toBe(true);
    expect(targets('settings-siri', '.bs-route-panel > :not(.bs-cta)')).toBe(true);
    expect(targets('settings-credits', '.bs-route-sheet')).toBe(true);
    expect(targets('settings-credits', '.bs-route-scrim')).toBe(true);
  });

  it('draws Routines with the real selector, next-routine card, "Ver Mais" row and two buttons', () => {
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    for (const route of Array.from(doc.querySelectorAll('.bs-route-routines'))) {
      expect(
        route.querySelectorAll(':scope > .bs-segments.bs-exercises-switch .bs-segment'),
      ).toHaveLength(2);
      expect(route.querySelectorAll(':scope > .bs-pane > .bs-line')).toHaveLength(1);
      expect(route.querySelectorAll(':scope > .bs-pane .bs-pane-row .bs-icon')).toHaveLength(1);
      expect(route.querySelector(':scope > .bs-routines-more .bone')).not.toBeNull();
      expect(route.querySelectorAll(':scope > .bs-pane-actions .bs-cta')).toHaveLength(2);
      expect(route.querySelector(':scope > .bs-route-link .bone')).not.toBeNull();
    }
  });

  it('puts bones inside every card of About, Credits, Assessments and Routines, never an empty white box', () => {
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    const boot = doc.getElementById('boot-skeleton')!;
    const cards = [
      '.bs-route-about .bs-pane',
      '.bs-route-assess .bs-pane',
      '.bs-route-routines .bs-pane',
      '.bs-route-sheet .bs-row',
    ];
    for (const selector of cards) {
      // A tela de destino aparece nos dois desenhos que a usam (treino e detalhe), então a conta é por desenho.
      const found = boot.querySelectorAll(selector);
      expect(found.length, selector).toBeGreaterThan(0);
      for (const card of Array.from(found))
        expect(card.querySelectorAll('.bone').length, selector).toBeGreaterThan(0);
    }
    // Os dois desenhos que usam a composição (treino e detalhe) levam as mesmas peças.
    const count = (selector: string) =>
      Array.from(boot.querySelectorAll('.bs-variant')).map(
        (variant) => variant.querySelectorAll(selector).length,
      );
    expect(count('.bs-route-about .bs-pane-row').filter((n) => n > 0)).toEqual([2, 2]);
    expect(count('.bs-route-sheet .bs-row').filter((n) => n > 0)).toEqual([3, 3]);
    expect(count('.bs-route-sheet .bs-cta').filter((n) => n > 0)).toEqual([1, 1]);
    expect(count('.bs-route-assess .bs-pane-actions .bs-cta').filter((n) => n > 0)).toEqual([2, 2]);
    expect(count('.bs-route-routines .bs-pane-actions .bs-cta').filter((n) => n > 0)).toEqual([
      2, 2,
    ]);
  });

  it('keeps the hand-off to the Angular drawing when the selector script has not run yet', () => {
    expect(BOOT_CSS).toContain('html:not([data-boot]) .bs-boot .bs-home');
  });

  it('keeps every rule of the inline first-paint sheet at zero specificity, so the external sheets always win', () => {
    const critical = new DOMParser()
      .parseFromString(INDEX, 'text/html')
      .querySelector('style[nonce="__CSP_NONCE__"]')!.textContent!;
    const body = critical.replace(/@media[^{]*{/g, '');
    const selectors = body.match(/[^{}]+(?={)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(3);
    for (const selector of selectors) expect(selector.trim().startsWith(':where(')).toBe(true);
    expect(critical).not.toMatch(/(^|[\s;{])color-scheme:/);
  });
});
