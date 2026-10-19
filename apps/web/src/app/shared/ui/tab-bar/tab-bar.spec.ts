import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Component } from '@angular/core';
import { TabBar } from './tab-bar';

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
});
