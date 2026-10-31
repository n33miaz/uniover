import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  AUTO_RUN_MS,
  ExerciseIllustration,
  FRAME_INTERVAL_MS,
  TAP_RUN_MS,
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

  it('alternates the light WebP poses in movement order', () => {
    create('puxada-aberta-na-polia', 'Puxada aberta na polia');
    expect(images().map((img) => img.getAttribute('src'))).toEqual([
      '/exercise-art/wide-grip-lat-pull-down-2.webp',
      '/exercise-art/wide-grip-lat-pull-down-1.webp',
    ]);
    expect(visible()[0]).toBe(images()[0]);
    vi.advanceTimersByTime(FRAME_INTERVAL_MS);
    fixture.detectChanges();
    expect(visible()[0]).toBe(images()[1]);
    expect(states).toEqual(['ready']);
  });

  it('names the whole drawing for assistive technology and keeps the poses out of the reading order', () => {
    create(SLUG, 'Supino reto com barra');
    expect(button()?.getAttribute('aria-label')).toBe('Supino reto com barra, repetir a animação');
    expect(
      images().every((img) => img.alt === '' && img.getAttribute('aria-hidden') === 'true'),
    ).toBe(true);
  });

  it('starts on the first pose and flips on its own', () => {
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

  it('draws both poses in exactly the same box', () => {
    create(SLUG);
    expect(images().every((img) => img.classList.contains('frame'))).toBe(true);
    expect(images().map((img) => [img.width, img.height])).toEqual([
      [268, 275],
      [268, 275],
    ]);
  });

  it('stops by itself after about 30 seconds and keeps the pose it was on', () => {
    create(SLUG);
    vi.advanceTimersByTime(AUTO_RUN_MS + FRAME_INTERVAL_MS * 3);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(0);
    const stopped = visible()[0];
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 4);
    fixture.detectChanges();
    expect(visible()[0]).toBe(stopped);
  });

  it('a tap flips the pose and makes it move again for about two minutes', () => {
    create(SLUG);
    vi.advanceTimersByTime(AUTO_RUN_MS + 1);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(0);
    const before = visible()[0];

    button()!.click();
    fixture.detectChanges();
    expect(visible()[0]).not.toBe(before);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    vi.advanceTimersByTime(TAP_RUN_MS - FRAME_INTERVAL_MS);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not animate with reduced motion: first pose, and a tap swaps the position', () => {
    reduced.set(true);
    create(SLUG);
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
    fixture.detectChanges();
    expect(visible()).toEqual([images()[0]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(button()?.getAttribute('aria-label')).toContain('trocar de posição');
    expect(el().textContent).not.toContain('Ver outra posição');

    button()!.click();
    fixture.detectChanges();
    expect(visible()).toEqual([images()[1]]);
    button()!.click();
    fixture.detectChanges();
    expect(visible()).toEqual([images()[0]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops and starts moving when the preference changes', () => {
    create(SLUG);
    reduced.set(true);
    fixture.detectChanges();
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 3);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(0);
    reduced.set(false);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(2);
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
    expect(vi.getTimerCount()).toBe(2);
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('declares no inline style in the markup', () => {
    create(SLUG);
    expect(el().querySelector('[style]')).toBeNull();
  });
});
