/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BootVariant, bootVariantFor } from './boot-variant';
import { PwaUpdateService } from './pwa-update.service';
import { UpdateSkeleton } from './update-skeleton';

@Component({ template: '' })
class Blank {}

// Os testes rodam a partir de apps/web.
const INDEX = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
const BOOT_ROUTE = readFileSync(resolve(process.cwd(), 'public/boot-route.js'), 'utf8');

const CASES: readonly (readonly [string, BootVariant])[] = [
  ['/', 'home'],
  ['/index.html', 'home'],
  ['/tv', 'tv'],
  ['/tv/', 'tv'],
  ['/tv/apps', 'tv'],
  ['/tv?painel=apps', 'tv'],
  ['/treino', 'training'],
  ['/treino/', 'training'],
  ['/treino/exercicios', 'training'],
  ['/ajustes', 'settings'],
  ['/ajustes/', 'settings'],
  ['/ajustes/sobre', 'detail'],
  ['/ajustes/sobre/creditos', 'detail'],
  ['/entrar', 'plain'],
  ['/entrar/qr', 'plain'],
  ['/convite', 'plain'],
  ['/boas-vindas', 'plain'],
  ['/conectar', 'plain'],
  ['/televisao', 'generic'],
  ['/treinoextra', 'generic'],
  ['/qualquer-coisa', 'generic'],
];

/** O que o `boot-route.js` marca na raiz para um endereço (o script roda sem Angular, então aqui ele é executado à parte). */
function runBootRoute(pathname: string): string | null {
  let marked: string | null = null;
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        if (name === 'data-boot') marked = value;
      },
    },
    getElementById: () => null,
  };
  new Function('location', 'document', 'setTimeout', BOOT_ROUTE)({ pathname }, document, () => 0);
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
      expect(runBootRoute(pathname), path).toBe(variant);
    }
  });

  it('sits beside app-root in index.html, loads the chooser first and keeps the CSP rules (no inline style, no inline script)', () => {
    const doc = new DOMParser().parseFromString(INDEX, 'text/html');
    const boot = doc.getElementById('boot-skeleton');
    expect(boot).not.toBeNull();
    expect(boot!.parentElement).toBe(doc.body);
    expect(doc.querySelector('app-root')!.contains(boot)).toBe(false);
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts.map((script) => script.getAttribute('src'))).toEqual(['boot-route.js']);
    expect(scripts[0].textContent).toBe('');
    expect(doc.head.contains(scripts[0])).toBe(true);
    expect(doc.querySelectorAll('[style]').length).toBe(0);
    expect(doc.querySelectorAll('style').length).toBe(0);
    expect(boot!.getAttribute('aria-hidden')).toBe('true');
  });

  const VARIANTS: readonly (readonly [BootVariant, string])[] = [
    ['home', '/'],
    ['tv', '/tv/'],
    ['training', '/treino/'],
    ['settings', '/ajustes'],
    ['detail', '/ajustes/sobre'],
    ['plain', '/entrar'],
    ['generic', '/qualquer-coisa'],
  ];

  for (const [variant, path] of VARIANTS) {
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
      const stat = doc.querySelector(`#boot-skeleton > .bs-variant.bs-${variant}`);
      expect(angular, 'overlay').not.toBeNull();
      expect(stat, 'static').not.toBeNull();
      expect(shape(angular!)).toBe(shape(stat!));
    });
  }
});
