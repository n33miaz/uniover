import { TestBed } from '@angular/core/testing';
import type { LocalExercise } from '../data/catalog/exercise';
import { EMPTY_FIELDS, type SetFields } from './set-draft';
import { LiveSetExtras, LiveSetFields } from './set-fields';

const bench = {
  id: 'supino-reto',
  recordType: 'weight_reps',
  equipment: 'barbell',
} as LocalExercise;

function extras(value: SetFields, collapsible: boolean) {
  const fixture = TestBed.createComponent(LiveSetExtras);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('collapsible', collapsible);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el };
}

const panel = (el: HTMLElement) => el.querySelector<HTMLElement>('.rpe')!;
const rpeButtons = (el: HTMLElement) => el.querySelectorAll<HTMLButtonElement>('.rpe-button');
const opener = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.opener')!;

describe('LiveSetExtras', () => {
  it('collapsed (live workout): the effort panel is hidden behind one opener until it is touched', () => {
    const { fixture, el } = extras(EMPTY_FIELDS, true);

    expect(panel(el).hidden).toBe(true);
    expect(opener(el).textContent).toContain('Esforço (RPE)');
    expect(opener(el).getAttribute('aria-expanded')).toBe('false');

    opener(el).click();
    fixture.detectChanges();

    expect(opener(el).getAttribute('aria-expanded')).toBe('true');
    expect(panel(el).hidden).toBe(false);
    expect(Array.from(rpeButtons(el)).map((button) => button.textContent?.trim())).toEqual([
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
  });

  it('collapsed: the opener controls a panel that exists, and the panel is labelled even while hidden', () => {
    const { fixture, el } = extras(EMPTY_FIELDS, true);

    const check = () => {
      const controlled = el.querySelector(`#${opener(el).getAttribute('aria-controls')}`);
      expect(controlled).toBe(panel(el));
      const label = el.querySelector(`#${panel(el).getAttribute('aria-labelledby')}`);
      expect(label?.textContent).toContain('Esforço (RPE)');
    };

    check();
    opener(el).click();
    fixture.detectChanges();
    check();
  });

  it('collapsed: a set that already has an effort shows it open', () => {
    const { el } = extras({ ...EMPTY_FIELDS, rpe: 8 }, true);

    expect(panel(el).hidden).toBe(false);
    expect(el.querySelector('.rpe-button[aria-pressed="true"]')?.textContent?.trim()).toBe('8');
  });

  it('collapsed: clearing the effort does not fold it under the finger', () => {
    const { fixture, el } = extras(EMPTY_FIELDS, true);
    opener(el).click();
    fixture.detectChanges();

    rpeButtons(el)[2].click();
    fixture.detectChanges();
    expect(fixture.componentInstance['value']().rpe).toBe(8);

    rpeButtons(el)[2].click();
    fixture.detectChanges();
    expect(fixture.componentInstance['value']().rpe).toBeNull();
    expect(panel(el).hidden).toBe(false);
  });

  it('a fresh instance (the next set or exercise) starts collapsed again', () => {
    const first = extras(EMPTY_FIELDS, true);
    opener(first.el).click();
    first.fixture.detectChanges();
    expect(panel(first.el).hidden).toBe(false);

    const next = extras(EMPTY_FIELDS, true);
    expect(panel(next.el).hidden).toBe(true);
    expect(opener(next.el).getAttribute('aria-expanded')).toBe('false');
  });

  it('open by default (edit sheet): the effort buttons and the note button are there with no opener', () => {
    const { el } = extras(EMPTY_FIELDS, false);

    expect(panel(el).hidden).toBe(false);
    expect(rpeButtons(el)).toHaveLength(5);
    expect(el.querySelector('.opener')).toBeNull();
    expect(el.querySelector('.note-open')).not.toBeNull();
    expect(
      el.querySelector(`#${panel(el).getAttribute('aria-labelledby')}`)?.textContent,
    ).toContain('Esforço (RPE)');
  });
});

describe('LiveSetFields', () => {
  function fields(extrasOn: boolean) {
    const fixture = TestBed.createComponent(LiveSetFields);
    fixture.componentRef.setInput('exercise', bench);
    fixture.componentRef.setInput('value', EMPTY_FIELDS);
    fixture.componentRef.setInput('extras', extrasOn);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('brings the effort and the note along by default, and leaves them out when asked', () => {
    expect(fields(true).querySelector('app-live-set-extras')).not.toBeNull();
    expect(fields(false).querySelector('app-live-set-extras')).toBeNull();
    expect(fields(false).querySelectorAll('app-live-stepper')).toHaveLength(2);
  });
});
