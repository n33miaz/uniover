import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ExerciseIllustration,
  FRAME_INTERVAL_MS,
  IllustrationState,
} from './exercise-illustration';
import { illustrationFor } from './illustration-map';
import { PrefersReducedMotion } from './prefers-reduced-motion';

const SLUG = 'supino-reto-com-barra';
const OTHER = 'agachamento-livre-com-barra';

describe('ExerciseIllustration', () => {
  const reduced = signal(false);
  let fixture: ComponentFixture<ExerciseIllustration>;
  let states: IllustrationState[];

  function create(slug: string, name = 'Supino reto com barra') {
    TestBed.configureTestingModule({
      providers: [{ provide: PrefersReducedMotion, useValue: { reduced } }],
    });
    fixture = TestBed.createComponent(ExerciseIllustration);
    states = [];
    fixture.componentInstance.stateChange.subscribe((state) => states.push(state));
    fixture.componentRef.setInput('slug', slug);
    fixture.componentRef.setInput('name', name);
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const images = () => Array.from(el().querySelectorAll<HTMLImageElement>('img'));
  const visible = () => images().filter((img) => img.classList.contains('on'));
  const button = () => el().querySelector<HTMLButtonElement>('button');

  beforeEach(() => {
    reduced.set(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('draws the two poses of the exercise from the same origin', () => {
    create(SLUG);
    const frames = illustrationFor(SLUG)!.frames;
    expect(images().map((img) => img.getAttribute('src'))).toEqual(
      frames.map((file) => `/exercise-art/${file}`),
    );
    expect(images().every((img) => img.getAttribute('loading') === 'lazy')).toBe(true);
    expect(states).toEqual(['ready']);
  });

  it('describes each pose with the name and its number', () => {
    create(SLUG, 'Supino reto com barra');
    expect(images().map((img) => img.alt)).toEqual([
      'Supino reto com barra, posição 1 de 2',
      'Supino reto com barra, posição 2 de 2',
    ]);
  });

  it('starts on the first pose and flips every second', () => {
    create(SLUG);
    expect(visible()).toEqual([images()[0]]);
    vi.advanceTimersByTime(FRAME_INTERVAL_MS - 1);
    fixture.detectChanges();
    expect(visible()).toEqual([images()[0]]);
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(visible()).toEqual([images()[1]]);
    vi.advanceTimersByTime(FRAME_INTERVAL_MS);
    fixture.detectChanges();
    expect(visible()).toEqual([images()[0]]);
  });

  it('hides the pose that is out of sight from assistive technology', () => {
    create(SLUG);
    expect(images()[0].hasAttribute('aria-hidden')).toBe(false);
    expect(images()[1].getAttribute('aria-hidden')).toBe('true');
  });

  it('has no button while it animates', () => {
    create(SLUG);
    expect(button()).toBeNull();
  });

  it('does not animate with reduced motion: first pose and a button to see the other one', () => {
    reduced.set(true);
    create(SLUG);
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
    fixture.detectChanges();
    expect(visible()).toEqual([images()[0]]);
    expect(button()?.textContent?.trim()).toBe('Ver outra posição');

    button()!.click();
    fixture.detectChanges();
    expect(visible()).toEqual([images()[1]]);
    button()!.click();
    fixture.detectChanges();
    expect(visible()).toEqual([images()[0]]);
  });

  it('stops and starts moving when the preference changes', () => {
    create(SLUG);
    reduced.set(true);
    fixture.detectChanges();
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 3);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(0);
    expect(button()).not.toBeNull();
    reduced.set(false);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(1);
    expect(button()).toBeNull();
  });

  it('renders no image, no button and no timer when there is no illustration, and says so', () => {
    create('exercicio-sem-arte');
    expect(images()).toEqual([]);
    expect(button()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(states).toEqual(['missing']);
  });

  it('never shows the figure of another exercise for an unknown slug', () => {
    create('abdominal-na-polia');
    expect(illustrationFor('abdominal-na-polia')).toBeUndefined();
    expect(el().querySelector('img')).toBeNull();
  });

  it('goes back to the first pose and reports again when the exercise changes', () => {
    create(SLUG);
    vi.advanceTimersByTime(FRAME_INTERVAL_MS);
    fixture.detectChanges();
    expect(visible()).toEqual([images()[1]]);

    fixture.componentRef.setInput('slug', OTHER);
    fixture.detectChanges();
    expect(visible()).toEqual([images()[0]]);
    expect(images()[0].getAttribute('src')).toContain(illustrationFor(OTHER)!.frames[0]);
    expect(states).toEqual(['ready', 'ready']);

    fixture.componentRef.setInput('slug', 'exercicio-sem-arte');
    fixture.detectChanges();
    expect(states).toEqual(['ready', 'ready', 'missing']);
    expect(images()).toEqual([]);
  });

  it('clears its timer when destroyed', () => {
    create(SLUG);
    expect(vi.getTimerCount()).toBe(1);
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('declares no inline style in the markup', () => {
    create(SLUG);
    expect(el().querySelector('[style]')).toBeNull();
  });
});
