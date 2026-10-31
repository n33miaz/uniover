import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { LocalBodyEntry } from '../data/body/body-entry';
import type { BodyMapRegion } from '../domain/body/body-map-signals';
import { BodyMapPanel } from './body-map-panel';

const entry = (measuredOn: string, values: Partial<LocalBodyEntry>): LocalBodyEntry => ({
  id: measuredOn,
  measuredOn,
  weightKg: null,
  bodyFatPct: null,
  fatMethod: null,
  waistCm: null,
  neckCm: null,
  hipCm: null,
  armCm: null,
  thighCm: null,
  note: '',
  updatedAt: 1,
  clientUpdatedAt: 1,
  deletedAt: null,
  ...values,
});

describe('BodyMapPanel', () => {
  let fixture: ComponentFixture<BodyMapPanel>;
  let el: HTMLElement;
  let opened: BodyMapRegion[];

  async function show(entries: LocalBodyEntry[]) {
    fixture = TestBed.createComponent(BodyMapPanel);
    opened = [];
    fixture.componentInstance.history.subscribe((region) => opened.push(region));
    fixture.componentRef.setInput('entries', entries);
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement as HTMLElement;
  }

  const zone = (muscle: string) => el.querySelector<SVGGElement>(`.zone[data-muscle="${muscle}"]`);

  it('shows the honest neutral state with no data: no legend, no symmetry, nothing painted', async () => {
    await show([]);

    expect(el.querySelector('h2')?.textContent).toContain('Mapa do Corpo');
    expect(el.querySelector('.hint')?.textContent).toContain('Sem comparação ainda');
    expect(el.querySelector('.scope')?.textContent).toContain('não mudam a silhueta');
    expect(el.querySelector('.map-values')?.textContent).toContain('Sem medida');
    expect(el.querySelector('.legend')).toBeNull();
    expect(el.querySelector('.symmetry')).toBeNull();
    expect(
      Array.from(el.querySelectorAll('.zone')).every(
        (node) => node.getAttribute('data-level') === '0',
      ),
    ).toBe(true);
  });

  it('explains that the first measurement has no comparison yet', async () => {
    await show([entry('2026-10-01', { waistCm: 82 })]);

    expect(el.querySelector('.hint')?.textContent).toContain('Sem comparação ainda');
    expect(el.querySelector('.legend')).toBeNull();
  });

  it('paints the regions by evolution and names each one for screen readers', async () => {
    await show([
      entry('2026-09-01', { chestCm: 96, thighRightCm: 58, thighLeftCm: 58 }),
      entry('2026-10-01', { chestCm: 98, thighRightCm: 57, thighLeftCm: 57 }),
    ]);

    expect(el.querySelector('.legend')).not.toBeNull();
    expect(el.querySelector('.hint')).toBeNull();
    expect(zone('chest')?.getAttribute('data-level')).toBe('3');
    expect(zone('chest')?.getAttribute('aria-label')).toBe('Tórax: cresceu');
    expect(zone('quadriceps')?.getAttribute('data-level')).toBe('1');
    expect(zone('quadriceps')?.getAttribute('aria-label')).toBe('Coxas: diminuiu');
    expect(zone('abdominals')?.getAttribute('aria-label')).toBe('Abdômen: sem comparação');
    expect(el.querySelector('.map-values')?.textContent).toContain('Tórax');
    expect(el.querySelector('.map-values')?.textContent).toContain('+2,0');
  });

  it('draws only the regions that have a measurement, never an unlabelled zone', async () => {
    await show([]);

    const muscles = Array.from(el.querySelectorAll('.zone')).map((node) =>
      node.getAttribute('data-muscle'),
    );
    expect(muscles.sort()).toEqual([
      'abdominals',
      'biceps',
      'calves',
      'chest',
      'forearms',
      'quadriceps',
    ]);
    expect(
      Array.from(el.querySelectorAll('.zone')).every((node) => !!node.getAttribute('aria-label')),
    ).toBe(true);
  });

  it('switches to the back face, where arm and thigh circumferences also paint', async () => {
    await show([entry('2026-10-01', { calfRightCm: 38 })]);

    Array.from(el.querySelectorAll<HTMLButtonElement>('.faces button'))
      .find((b) => b.textContent?.includes('Costas'))!
      .click();
    fixture.detectChanges();

    const muscles = Array.from(el.querySelectorAll('.zone')).map((node) =>
      node.getAttribute('data-muscle'),
    );
    expect(muscles.sort()).toEqual(['calves', 'forearms', 'hamstrings', 'triceps']);
    expect(el.querySelector('svg')?.getAttribute('aria-label')).toBe('Mapa do corpo, de costas');
  });

  it('opens the history of the region touched on the silhouette', async () => {
    await show([entry('2026-10-01', { chestCm: 98 })]);

    zone('chest')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    zone('biceps')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(opened).toEqual(['chest', 'arm']);
  });

  it('shows the right x left card with the larger side and highlights only relevant differences', async () => {
    await show([
      entry('2026-10-01', { armRightCm: 35, armLeftCm: 33.5, calfRightCm: 38, calfLeftCm: 38.3 }),
    ]);

    const cards = Array.from(el.querySelectorAll<HTMLButtonElement>('.side-card'));
    const arm = cards.find((card) => card.textContent?.includes('Braços'))!;
    const calf = cards.find((card) => card.textContent?.includes('Panturrilhas'))!;
    expect(arm.classList.contains('relevant')).toBe(true);
    expect(arm.querySelector('.side-note')?.textContent).toContain('D maior');
    expect(arm.querySelector('.side-note')?.textContent).toContain('1,5');
    // Falado por extenso em texto escondido (e não em aria-label), para o nome do botão conter o que se vê.
    expect(arm.hasAttribute('aria-label')).toBe(false);
    expect(arm.querySelector('.ui-visually-hidden')?.textContent).toContain('direito 35,0');
    expect(arm.querySelector('.ui-visually-hidden')?.textContent).toContain('direito maior em');
    expect(calf.classList.contains('relevant')).toBe(false);
    expect(calf.querySelector('.side-note')?.textContent).toContain('Lados próximos');

    arm.click();
    expect(opened).toEqual(['arm']);
  });

  it('asks for the other side instead of inventing a difference', async () => {
    await show([entry('2026-10-01', { forearmRightCm: 28 })]);

    const card = el.querySelector<HTMLButtonElement>('.side-card')!;
    expect(card.textContent).toContain('Registre os dois lados');
    expect(card.querySelector('.side-values')).toBeNull();
  });
});
