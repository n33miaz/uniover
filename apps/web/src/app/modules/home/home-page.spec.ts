import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HomePage } from './home-page';

describe('HomePage', () => {
  it('lists the TV and Treino modules as links', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(HomePage);
    await fixture.whenStable();
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('a.card'),
    );
    expect(links.map((a) => a.textContent?.trim())).toEqual(['TV', 'Treino']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/tv', '/treino']);
  });
});
