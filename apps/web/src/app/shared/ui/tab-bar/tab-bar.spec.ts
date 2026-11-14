import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Component } from '@angular/core';
import { TabBar, TabItem } from './tab-bar';

@Component({ template: '' })
class Blank {}

describe('TabBar', () => {
  it('renders one link per tab and marks the current one', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'a', component: Blank },
          { path: 'b', component: Blank },
        ]),
      ],
    });
    const harness = await RouterTestingHarness.create('/b');
    const fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('tabs', [
      { link: '/a', label: 'Primeira' },
      { link: '/b', label: 'Segunda' },
    ]);
    await fixture.whenStable();
    void harness;
    const links = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a'));
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Primeira', 'Segunda']);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page']);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('nav')?.getAttribute('aria-label'),
    ).toBe('Abas do módulo');
  });

  it('uses the icon-and-name bar in any module whose tabs carry icons', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: Blank }])],
    });
    await RouterTestingHarness.create('/pc');
    const draw = async (tabs: readonly TabItem[]) => {
      const fixture = TestBed.createComponent(TabBar);
      fixture.componentRef.setInput('tabs', tabs);
      await fixture.whenStable();
      return fixture.nativeElement as HTMLElement;
    };
    const withIcons = await draw([
      { link: '/pc', label: 'Mouse', icon: 'mouse' },
      { link: '/pc/atalhos', label: 'Atalhos', icon: 'shortcuts' },
      { link: '/pc/midia', label: 'Mídia', icon: 'media' },
      { link: '/pc/mais', label: 'Mais', icon: 'more' },
    ]);
    expect(withIcons.querySelector('nav')?.classList.contains('training')).toBe(true);
    expect(withIcons.querySelectorAll('svg.icon')).toHaveLength(4);
    for (const svg of Array.from(withIcons.querySelectorAll('svg.icon'))) {
      expect(svg.children.length, 'every icon draws something').toBeGreaterThan(0);
    }
    const textOnly = await draw([{ link: '/pc', label: 'Mouse' }]);
    expect(textOnly.querySelector('nav')?.classList.contains('training')).toBe(false);
    expect(textOnly.querySelector('svg.icon')).toBeNull();
  });

  describe('marking by path', () => {
    // As abas do Treino, como o módulo as declara: Exercícios cobre as telas filhas e as rotinas.
    const TABS: readonly TabItem[] = [
      { link: '/treino', label: 'Hoje' },
      { link: '/treino/exercicios', nested: true, also: ['/treino/rotinas'], label: 'Exercícios' },
      { link: '/treino/progresso', label: 'Progresso' },
      { link: '/treino/corpo', label: 'Corpo' },
    ];

    async function render(url: string, tabs: readonly TabItem[] = TABS) {
      // Alguns testes montam a barra mais de uma vez: cada montagem começa de um módulo de teste novo.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [provideRouter([{ path: '**', component: Blank }])],
      });
      const harness = await RouterTestingHarness.create(url);
      const fixture = TestBed.createComponent(TabBar);
      fixture.componentRef.setInput('tabs', tabs);
      await fixture.whenStable();
      const marked = () =>
        Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a'))
          .filter((a) => a.getAttribute('aria-current') === 'page')
          .map((a) => a.textContent?.trim());
      return { harness, fixture, marked };
    }

    it.each([
      ['/treino', ['Hoje']],
      ['/treino/', ['Hoje']],
      ['/treino/exercicios', ['Exercícios']],
      ['/treino/exercicios?q=supino&group=chest', ['Exercícios']],
      ['/treino/exercicios/abc', ['Exercícios']],
      ['/treino/exercicios/abc/editar', ['Exercícios']],
      ['/treino/rotinas', ['Exercícios']],
      ['/treino/rotinas/abc', ['Exercícios']],
      ['/treino/progresso', ['Progresso']],
      ['/treino/progresso?exercise=abc', ['Progresso']],
      ['/treino/corpo', ['Corpo']],
    ])('%s marks only %j', async (url, expected) => {
      const { marked } = await render(url);
      expect(marked()).toEqual(expected);
    });

    it('does not take a path that only starts with the same letters for a child', async () => {
      const { marked } = await render('/treino/exercicios2');
      expect(marked()).toEqual([]);
      const rotinas = await render('/treino/rotinas-antigas');
      expect(rotinas.marked()).toEqual([]);
    });

    it('marks the tab of its own path only, without nested or also (how every tab worked before)', async () => {
      const plain: readonly TabItem[] = [
        { link: '/a', label: 'Primeira' },
        { link: '/a/b', label: 'Segunda' },
      ];
      const { marked } = await render('/a/b', plain);
      expect(marked()).toEqual(['Segunda']);
      const parent = await render('/a/b/c', plain);
      expect(parent.marked()).toEqual([]);
    });

    it('follows the navigation: the mark moves with the screen', async () => {
      const { harness, fixture, marked } = await render('/treino/exercicios');
      expect(marked()).toEqual(['Exercícios']);
      await harness.navigateByUrl('/treino/rotinas/xyz');
      fixture.detectChanges();
      expect(marked()).toEqual(['Exercícios']);
      await TestBed.inject(Router).navigateByUrl('/treino/corpo');
      fixture.detectChanges();
      expect(marked()).toEqual(['Corpo']);
      await TestBed.inject(Router).navigateByUrl('/treino');
      fixture.detectChanges();
      expect(marked()).toEqual(['Hoje']);
    });
  });
});
