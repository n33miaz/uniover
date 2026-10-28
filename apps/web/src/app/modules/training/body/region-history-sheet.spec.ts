import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { LocalBodyEntry } from '../data/body/body-entry';
import type { BodyMapRegion } from '../domain/body/body-map-signals';
import { BodyRegionHistorySheet } from './region-history-sheet';

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

describe('BodyRegionHistorySheet', () => {
  let fixture: ComponentFixture<BodyRegionHistorySheet>;
  let el: HTMLElement;

  async function show(region: BodyMapRegion, entries: LocalBodyEntry[]) {
    fixture = TestBed.createComponent(BodyRegionHistorySheet);
    fixture.componentRef.setInput('region', region);
    fixture.componentRef.setInput('entries', entries);
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement as HTMLElement;
  }

  const text = (node: Element | null) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('lists the newest first with right and left side by side and the change of each side', async () => {
    await show('arm', [
      entry('2026-09-01', { armRightCm: 33, armLeftCm: 32 }),
      entry('2026-10-01', { armRightCm: 34.5, armLeftCm: 31.5 }),
    ]);

    const rows = Array.from(el.querySelectorAll('.row'));
    expect(rows).toHaveLength(2);
    expect(text(rows[0])).toContain('01/10/2026');
    expect(text(rows[0])).toContain('34,5');
    expect(text(rows[0])).toContain('+1,5');
    expect(text(rows[0])).toContain('31,5');
    expect(text(rows[0])).toContain('−0,5');
    expect(text(rows[1])).toContain('01/09/2026');
    expect(rows[1].querySelectorAll('small').length).toBe(0);
    expect(rows[0].querySelectorAll('.cell')).toHaveLength(2);
  });

  it('names the sides for screen readers without relying on the letters D and E alone', async () => {
    await show('thigh', [entry('2026-10-01', { thighRightCm: 58, thighLeftCm: 58.2 })]);

    const hidden = Array.from(el.querySelectorAll('.ui-visually-hidden')).map((node) => text(node));
    expect(hidden).toEqual(['Direito', 'Esquerdo']);
    expect(el.querySelector('.tag')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the old unsided value with no side tag', async () => {
    await show('arm', [entry('2026-10-01', { armCm: 36 })]);

    expect(el.querySelector('.tag')).toBeNull();
    expect(text(el.querySelector('.cell'))).toContain('36,0');
  });

  it('says there is nothing to show for a region never measured, and offers to register', async () => {
    await show('chest', [entry('2026-10-01', { armCm: 36 })]);
    let registered = 0;
    fixture.componentInstance.register.subscribe(() => registered++);

    expect(el.querySelector('.rows')).toBeNull();
    expect(text(el.querySelector('.empty'))).toContain('Ainda não há medidas');
    el.querySelector<HTMLButtonElement>('[sheetaction], button.primary')?.click();
    expect(registered).toBe(1);
  });

  it('titles the sheet after the region', async () => {
    await show('calf', []);

    expect(text(el.querySelector('h2, h3'))).toContain('Histórico de Panturrilhas');
  });
});
