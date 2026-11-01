/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { routes } from '../../app.routes';
import { TRAINING_ROUTES } from '../../modules/training/training.routes';
import { BootVariant, bootVariantFor } from './boot-variant';
import { PwaUpdateService } from './pwa-update.service';
import { UpdateSkeleton } from './update-skeleton';

@Component({ template: '' })
class Blank {}

// Os testes rodam a partir de apps/web.
const INDEX = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
const BOOT_CSS = readFileSync(resolve(process.cwd(), 'src/boot-skeleton.css'), 'utf8');
const BOOT_SELECTOR = new DOMParser()
  .parseFromString(INDEX, 'text/html')
  .head.querySelector('script[nonce]')!.textContent!;

const CASES: readonly (readonly [string, BootVariant])[] = [
  ['/', 'home'],
  ['/index.html', 'home'],
  ['/tv', 'tv'],
  ['/tv/', 'tv'],
  ['/tv/apps', 'tv'],
  ['/tv?painel=apps', 'tv'],
  ['/treino', 'training-today'],
  ['/treino/', 'training-today'],
  ['/treino/rotinas', 'training-list'],
  ['/treino/exercicios', 'training-list'],
  ['/treino/progresso', 'training-progress'],
  ['/treino/corpo', 'training-body'],
  ['/ajustes', 'settings'],
  ['/ajustes/', 'settings'],
  ['/ajustes/sistema', 'settings-system'],
  ['/ajustes/pessoas', 'settings-people'],
  ['/ajustes/auditoria', 'settings-audit'],
  ['/ajustes/dispositivos', 'settings-devices'],
  ['/ajustes/perfil', 'settings-profile'],
  ['/ajustes/aparencia', 'settings-appearance'],
  ['/ajustes/sobre', 'detail'],
  ['/ajustes/sobre/creditos', 'detail'],
  ['/entrar', 'plain'],
  ['/entrar/qr', 'plain'],
  ['/convite', 'plain'],
  ['/boas-vindas', 'plain'],
  ['/conectar', 'plain'],
  ['/televisao', 'detail'],
  ['/treinoextra', 'detail'],
  ['/qualquer-coisa', 'detail'],
];

/** O que o seletor em linha marca na raiz para um endereço (ele roda sem Angular, então aqui é executado à parte). */
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
  };
  new Function('location', 'document', 'setTimeout', BOOT_SELECTOR)(
    { pathname, reload: () => undefined },
    document,
    () => 0,
  );
  return marked;
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

  it('sits beside app-root in index.html and authorizes the first-paint selector with the server nonce', () => {
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    const boot = doc.getElementById('boot-skeleton');
    expect(boot).not.toBeNull();
    expect(boot!.parentElement).toBe(doc.body);
    expect(doc.querySelector('app-root')!.contains(boot)).toBe(false);
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('src')).toBeNull();
    expect(scripts[0].getAttribute('nonce')).toBe('__CSP_NONCE__');
    expect(scripts[0].textContent).toContain("document.documentElement.setAttribute('data-boot', v)");
    expect(doc.head.contains(scripts[0])).toBe(true);
    expect(doc.querySelectorAll('[style]').length).toBe(0);
    expect(doc.querySelectorAll('style').length).toBe(0);
    expect(boot!.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the static drawing visible and offers a retry when the app does not start', () => {
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    expect(BOOT_SELECTOR).toContain("el.setAttribute('data-boot-timeout', 'true')");
    expect(BOOT_SELECTOR).toContain("location.reload()");
    expect(doc.getElementById('boot-timeout')?.getAttribute('role')).toBe('alert');
    expect(doc.getElementById('boot-timeout-retry')?.tagName).toBe('BUTTON');
    expect(BOOT_CSS).not.toContain('.bs-root.bs-stale');
  });

  const VARIANTS: readonly (readonly [BootVariant, string, string?])[] = [
    ['home', '/'],
    ['tv', '/tv/'],
    ['training-today', '/treino/', 'training'],
    ['training-list', '/treino/rotinas', 'training'],
    ['training-progress', '/treino/progresso', 'training'],
    ['training-body', '/treino/corpo', 'training'],
    ['settings', '/ajustes'],
    ['settings-system', '/ajustes/sistema', 'detail'],
    ['settings-people', '/ajustes/pessoas', 'detail'],
    ['settings-audit', '/ajustes/auditoria', 'detail'],
    ['settings-devices', '/ajustes/dispositivos', 'detail'],
    ['settings-profile', '/ajustes/perfil', 'detail'],
    ['settings-appearance', '/ajustes/aparencia', 'detail'],
    ['detail', '/ajustes/sobre'],
    ['plain', '/entrar'],
  ];

  for (const [variant, path, mappedDrawing] of VARIANTS) {
    it(`draws the ${variant} skeleton with the same shapes in index.html and in the Angular overlay`, async () => {
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
    const shell = routes.find((route) => route.path === '')!;
    const settings = shell.children!.find((route) => route.path === 'ajustes')!;
    const expectedSettings: Readonly<Record<string, BootVariant>> = {
      '': 'settings',
      perfil: 'settings-profile',
      aparencia: 'settings-appearance',
      seguranca: 'detail',
      pessoas: 'settings-people',
      'tvs-por-pessoa': 'detail',
      'tv/:id/historico': 'detail',
      auditoria: 'settings-audit',
      sistema: 'settings-system',
      dispositivos: 'settings-devices',
      aparelhos: 'settings-devices',
      sobre: 'detail',
      creditos: 'detail',
    };
    const actualSettings = settings.children!
      .filter((route) => route.path !== undefined)
      .map((route) => route.path!);
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

  it('keeps a distinct visible composition for each training and settings destination', () => {
    for (const variant of [
      'training-today',
      'training-list',
      'training-progress',
      'training-body',
      'settings-system',
      'settings-people',
      'settings-audit',
      'settings-devices',
      'settings-profile',
      'settings-appearance',
    ]) {
      expect(BOOT_CSS).toContain(`data-boot='${variant}'`);
      expect(BOOT_CSS).toContain(`data-boot-variant='${variant}'`);
    }
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    const training = doc.querySelector('.bs-training')!;
    expect(training.querySelector('.bs-training-list-content .bs-row')).not.toBeNull();
    expect(training.querySelector('.bs-training-progress-content .bs-chart-line')).not.toBeNull();
    expect(training.querySelector('.bs-training-body-content .bs-figure')).not.toBeNull();
    const detail = doc.querySelector('.bs-detail')!;
    expect(detail.querySelector('.bs-settings-data-content .bs-row')).not.toBeNull();
    expect(detail.querySelector('.bs-settings-profile-content .bs-identity')).not.toBeNull();
    expect(detail.querySelectorAll('.bs-settings-appearance-content .bs-theme-choice')).toHaveLength(3);
  });
});
