import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PrefersReducedMotion } from '../../illustrations/prefers-reduced-motion';
import { BodyFigure } from './body-figure';
import { rectPath } from './body-shapes';
import { BODY_ZONES, BodyFace } from './body-zones';

describe('BodyFigure motion', () => {
  const reduced = signal(false);
  let fixture: ComponentFixture<BodyFigure>;
  let animate: ReturnType<typeof vi.fn>;
  let cancellations: ReturnType<typeof vi.fn>[];
  let originalAnimate: PropertyDescriptor | undefined;

  async function show(face: BodyFace) {
    fixture.componentRef.setInput('face', face);
    fixture.componentRef.setInput('label', face);
    fixture.componentRef.setInput(
      'zones',
      BODY_ZONES[face].map((zone) => ({
        ...zone,
        tiles: zone.tiles.map(rectPath),
        level: 0,
        label: zone.muscle,
        selected: false,
      })),
    );
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    reduced.set(false);
    cancellations = [];
    animate = vi.fn(() => {
      const cancel = vi.fn();
      cancellations.push(cancel);
      return { cancel };
    });
    originalAnimate = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'animate');
    Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: animate });
    TestBed.configureTestingModule({
      providers: [{ provide: PrefersReducedMotion, useValue: { reduced } }],
    });
    fixture = TestBed.createComponent(BodyFigure);
  });

  afterEach(() => {
    fixture.destroy();
    if (originalAnimate) Object.defineProperty(SVGElement.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(SVGElement.prototype, 'animate');
  });

  it('starts still, then turns in both directions without retaining outgoing buttons', async () => {
    await show('front');
    expect(animate).not.toHaveBeenCalled();
    await show('back');
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0][0].transform).toContain('rotateY(24deg)');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('svg')).toHaveLength(1);
    expect(el.querySelector('[data-muscle="chest"]')).toBeNull();
    expect(el.querySelector('[data-muscle="lats"]')?.getAttribute('tabindex')).toBe('0');

    await show('front');
    expect(cancellations[0]).toHaveBeenCalledOnce();
    expect(animate.mock.calls[1][0][0].transform).toContain('rotateY(-24deg)');
    expect(el.querySelector('[data-muscle="lats"]')).toBeNull();
    expect(el.querySelector('[data-muscle="chest"]')?.getAttribute('tabindex')).toBe('0');
  });

  it('keeps the current animation when only selection or volume changes', async () => {
    await show('front');
    await show('back');
    await show('back');
    expect(animate).toHaveBeenCalledOnce();
    expect(cancellations[0]).not.toHaveBeenCalled();
  });

  it('switches immediately with reduced motion and cancels motion when the preference changes', async () => {
    reduced.set(true);
    await show('front');
    await show('back');
    expect(animate).not.toHaveBeenCalled();

    reduced.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate).not.toHaveBeenCalled();
    await show('front');
    expect(animate).toHaveBeenCalledOnce();
    reduced.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cancellations[0]).toHaveBeenCalledOnce();
    await show('back');
    expect(animate).toHaveBeenCalledOnce();
  });

  it('cancels a turn when the figure is removed', async () => {
    await show('front');
    await show('back');
    fixture.destroy();
    expect(cancellations[0]).toHaveBeenCalledOnce();
  });
});
