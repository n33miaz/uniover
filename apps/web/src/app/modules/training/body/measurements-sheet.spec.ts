import { ComponentFixture, TestBed } from '@angular/core/testing';
import { setupBody } from '../data/body/body-data-test-kit';
import type { LocalBodyProfile } from '../data/body/body-profile';
import { navyBodyFat } from '../domain/body/navy-body-fat';
import { BodyMeasurementsSheet } from './measurements-sheet';

describe('BodyMeasurementsSheet', () => {
  let fixture: ComponentFixture<BodyMeasurementsSheet>;
  let el: HTMLElement;
  let kit: ReturnType<typeof setupBody>;

  async function open(profile: LocalBodyProfile | null = null, age: number | null = null) {
    kit = setupBody();
    fixture = TestBed.createComponent(BodyMeasurementsSheet);
    fixture.componentRef.setInput('today', '2025-10-09');
    fixture.componentRef.setInput('profile', profile);
    fixture.componentRef.setInput('age', age);
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement as HTMLElement;
  }

  const field = (label: string) => {
    const labels = Array.from(el.querySelectorAll<HTMLLabelElement>('label'));
    const found = labels.find((item) => item.textContent?.trim() === label);
    if (!found) throw new Error(`campo "${label}" não existe`);
    return el.querySelector<HTMLInputElement>(`#${found.htmlFor}`)!;
  };
  const type = (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const save = async () => {
    el.querySelector<HTMLButtonElement>('button.primary')!.click();
    await vi.waitFor(async () =>
      expect((await kit.repository.entries()).length).toBeGreaterThan(0),
    );
  };

  it('groups the fields as trunk, arms, legs and skinfolds, with the unit in the group title', async () => {
    await open();

    const groups = Array.from(el.querySelectorAll('fieldset.measure-group')).map((group) => ({
      title: group.querySelector('legend')?.textContent?.trim(),
      labels: Array.from(group.querySelectorAll('label')).map((label) => label.textContent?.trim()),
    }));
    expect(groups).toEqual([
      { title: 'Tronco (cm)', labels: ['Cintura', 'Abdômen', 'Tórax', 'Pescoço'] },
      { title: 'Braços (cm)', labels: ['Braço D', 'Braço E', 'Antebraço D', 'Antebraço E'] },
      { title: 'Pernas (cm)', labels: ['Coxa D', 'Coxa E', 'Panturrilha D', 'Panturrilha E'] },
      { title: 'Dobras (mm)', labels: ['Peitoral', 'Abdominal', 'Coxa'] },
    ]);
  });

  it('asks for the hip only when the profile needs it', async () => {
    await open({
      heightCm: 165,
      birthDate: '1995-06-15',
      sex: 'female',
      activityFactor: 1.55,
      updatedAt: 1,
      clientUpdatedAt: 1,
    } as LocalBodyProfile);

    expect(el.querySelector('fieldset.measure-group')?.textContent).toContain('Quadril');
  });

  it('saves the new measurements with their side and leaves the unfilled ones empty', async () => {
    await open();
    type('Tórax', '98,5');
    type('Braço D', '35');
    type('Braço E', '33,5');
    type('Panturrilha E', '38');
    type('Peitoral', '9,5');

    await save();

    const [row] = await kit.repository.entries();
    expect(row).toMatchObject({
      chestCm: 98.5,
      armRightCm: 35,
      armLeftCm: 33.5,
      calfLeftCm: 38,
      chestSkinfoldMm: 9.5,
      waistCm: null,
      forearmRightCm: null,
      thighRightCm: null,
      armCm: null,
    });
    await vi.waitFor(async () => expect(await kit.outbox()).toHaveLength(1));
    const [queued] = await kit.outbox();
    expect(queued.body).toMatchObject({
      chestCm: 98.5,
      armRightCm: 35,
      calfRightCm: null,
      chestSkinfoldMm: 9.5,
    });
  });

  it('accepts a measurement made only of new fields, and refuses values out of range', async () => {
    await open();
    type('Abdômen', '8');
    el.querySelector<HTMLButtonElement>('button.primary')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Confira');
    });
    expect(await kit.repository.entries()).toEqual([]);

    type('Abdômen', '82');
    await save();
    expect((await kit.repository.entries())[0]).toMatchObject({ abdomenCm: 82 });
  });

  it('refuses a skinfold outside 1 to 100 mm with a message that names the unit', async () => {
    await open();
    type('Peitoral', '120');
    el.querySelector<HTMLButtonElement>('button.primary')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('mm');
    });
  });

  it('feeds the Navy estimate with the abdomen for men and falls back to the waist', async () => {
    const man = {
      heightCm: 180,
      birthDate: '1995-06-15',
      sex: 'male',
      activityFactor: 1.55,
    } as LocalBodyProfile;
    await open(man, 31);
    type('Cintura', '80');
    type('Abdômen', '90');
    type('Pescoço', '38');
    Array.from(el.querySelectorAll<HTMLButtonElement>('button.secondary'))
      .find((button) => button.textContent?.includes('Marinha'))!
      .click();
    fixture.detectChanges();

    const fromAbdomen = navyBodyFat({
      sex: 'male',
      heightCm: 180,
      ageYears: 31,
      waistCm: 90,
      neckCm: 38,
    });
    const fromWaist = navyBodyFat({
      sex: 'male',
      heightCm: 180,
      ageYears: 31,
      waistCm: 80,
      neckCm: 38,
    });
    expect(fromAbdomen).not.toBe(fromWaist);
    expect(el.querySelector('.navy-result')?.textContent).toContain(
      String(fromAbdomen).replace('.', ','),
    );
  });
});
