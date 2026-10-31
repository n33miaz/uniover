import { TestBed } from '@angular/core/testing';
import { MuscleId } from '../../domain/taxonomy';
import { ExerciseMuscles } from './exercise-muscles';

describe('ExerciseMuscles', () => {
  function create(primary: MuscleId[], secondary: MuscleId[] = []) {
    const fixture = TestBed.createComponent(ExerciseMuscles);
    fixture.componentRef.setInput('primary', primary);
    fixture.componentRef.setInput('secondary', secondary);
    fixture.detectChanges();
    return fixture;
  }

  const captions = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('figcaption')).map((caption) => caption.textContent);

  it('shows only the front for muscles that are visible from the front', () => {
    const fixture = create(['chest'], ['biceps']);
    expect(captions(fixture.nativeElement)).toEqual(['Frente']);
    expect(
      fixture.nativeElement.querySelector('.muscle-figures').classList.contains('single'),
    ).toBe(true);
  });

  it('shows only the back for muscles that are visible from the back', () => {
    const fixture = create(['lats'], ['middle_back']);
    expect(captions(fixture.nativeElement)).toEqual(['Costas']);
  });

  it('includes both faces when primary or secondary muscles need them', () => {
    const fixture = create(['chest'], ['triceps']);
    expect(captions(fixture.nativeElement)).toEqual(['Frente', 'Costas']);
    expect(fixture.nativeElement.querySelectorAll('.zone.primary')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('.zone.secondary')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('svg')[0].getAttribute('aria-label')).toBe(
      'Frente; principais: Peitoral',
    );
    expect(fixture.nativeElement.querySelectorAll('svg')[1].getAttribute('aria-label')).toBe(
      'Costas; secundários: Tríceps',
    );
    expect(
      fixture.nativeElement.querySelector('.muscle-figures').classList.contains('single'),
    ).toBe(false);
  });

  it('updates the visible faces when another exercise is loaded', () => {
    const fixture = create(['chest']);
    fixture.componentRef.setInput('primary', ['lats']);
    fixture.detectChanges();
    expect(captions(fixture.nativeElement)).toEqual(['Costas']);
  });

  it('copies the size of the illustration card only when it sits beside one', () => {
    const fixture = create(['chest'], ['triceps']);
    expect(fixture.nativeElement.classList.contains('fill')).toBe(false);
    fixture.componentRef.setInput('fill', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.classList.contains('fill')).toBe(true);
  });
});
