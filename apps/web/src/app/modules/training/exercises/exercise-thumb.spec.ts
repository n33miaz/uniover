import { TestBed } from '@angular/core/testing';
import { ExerciseThumb } from './exercise-thumb';

describe('ExerciseThumb', () => {
  function render(slug: string | null) {
    const fixture = TestBed.createComponent(ExerciseThumb);
    fixture.componentRef.setInput('slug', slug);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the first pose of a confirmed illustration, hidden from screen readers', () => {
    const el = render('supino-reto-com-barra');
    expect(el.classList.contains('thumb')).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('img')?.getAttribute('src')).toContain('/exercise-art/');
    expect(el.querySelector('.placeholder')).toBeNull();
  });

  it('falls back to the neutral frame without a safe illustration or without the exercise', () => {
    for (const slug of ['prancha-isometrica', null]) {
      const el = render(slug);
      expect(el.querySelector('img'), String(slug)).toBeNull();
      expect(el.querySelector('.placeholder app-training-glyph'), String(slug)).not.toBeNull();
    }
  });
});
