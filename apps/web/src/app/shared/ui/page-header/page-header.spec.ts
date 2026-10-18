import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PageHeader } from './page-header';

describe('PageHeader', () => {
  it('shows the heading and a link back home', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(PageHeader);
    fixture.componentRef.setInput('heading', 'Título');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('Título');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/');
  });
});
