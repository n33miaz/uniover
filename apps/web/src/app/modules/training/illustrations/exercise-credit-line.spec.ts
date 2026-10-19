import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ART_LICENSE_URL, ExerciseCreditLine } from './exercise-credit-line';

describe('ExerciseCreditLine', () => {
  async function render() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(ExerciseCreditLine);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('credits the source, the author and the license in one line', async () => {
    const el = await render();
    expect(el.textContent?.replace(/\s+/g, ' ').trim()).toContain(
      'Ilustração: Everkinetic (Greg Priday), CC BY-SA 4.0',
    );
  });

  it('links the license safely and opens the credits screen from inside the app', async () => {
    const el = await render();
    const license = el.querySelector<HTMLAnchorElement>(`a[href="${ART_LICENSE_URL}"]`)!;
    expect(ART_LICENSE_URL).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    expect(license.target).toBe('_blank');
    expect(license.rel).toContain('noopener');
    expect(license.rel).toContain('noreferrer');
    const credits = Array.from(el.querySelectorAll('a')).find(
      (a) => a.textContent?.trim() === 'Créditos',
    )!;
    expect(credits.getAttribute('href')).toBe('/ajustes/creditos');
    expect(credits.target).toBe('');
  });
});
