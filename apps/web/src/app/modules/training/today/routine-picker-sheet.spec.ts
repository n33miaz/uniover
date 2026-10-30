import { TestBed } from '@angular/core/testing';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { CalendarEntryRepository } from '../data/calendar/calendar-entry-repository';
import { GoalRepository } from '../data/goals/goal-repository';
import { setupTraining } from '../data/sync/training-test-kit';
import { dateKey, deviceTimeZone } from '../domain/progress/calendar';
import { eventually } from '../shell/screen-test-kit';
import { RoutinePickerSheet } from './routine-picker-sheet';

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

async function open() {
  const kit = setupTraining();
  kit.pause();
  const fixture = TestBed.createComponent(RoutinePickerSheet);
  fixture.componentRef.setInput('entries', []);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  await eventually(fixture, () => expect(element.querySelector('.settings')).not.toBeNull());
  const todayKey = dateKey(TestBed.inject(QUEUE_RUNTIME).now(), deviceTimeZone());
  return { kit, fixture, element, todayKey };
}

const click = (element: HTMLElement, label: string) =>
  Array.from(element.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(label))!
    .click();

async function settled(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('RoutinePickerSheet agenda', () => {
  afterEach(() => localStorage.clear());

  it('does not let a note and an absence saved together erase each other', async () => {
    const { fixture, element, todayKey } = await open();
    const entries = TestBed.inject(CalendarEntryRepository);
    element.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Ombro doendo';
    click(element, 'Salvar Nota');
    click(element, 'Marcar Ausência');
    await settled(fixture);
    await vi.waitFor(async () =>
      expect(await entries.get(todayKey)).toMatchObject({ absent: true, note: 'Ombro doendo' }),
    );
  });

  it('says the device is full, and keeps the typed values, when the goal cannot be saved', async () => {
    const { kit, fixture, element } = await open();
    vi.spyOn(kit.db.outbox, 'add').mockRejectedValue(quota());
    const input = element.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.value = '5';
    click(element, 'Salvar Meta');
    await settled(fixture);
    await eventually(fixture, () =>
      expect(element.querySelector('.status')?.textContent).toContain('sem espaço'),
    );
    expect(element.querySelector('.status')?.textContent).not.toContain('Use de 1 a 14');
    expect(input.value).toBe('5');
    expect(await TestBed.inject(GoalRepository).value('weekly_sessions')).toBeNull();
  });

  it('does not claim the absence was marked when nothing fit on the device', async () => {
    const { kit, fixture, element } = await open();
    vi.spyOn(kit.db.outbox, 'add').mockRejectedValue(quota());
    click(element, 'Marcar Ausência');
    await settled(fixture);
    await eventually(fixture, () =>
      expect(element.querySelector('.status')?.textContent).toContain('sem espaço'),
    );
    expect(element.querySelector('.status')?.textContent).not.toContain('Ausência marcada');
  });

  it('reports a partly saved absence range with the exact count', async () => {
    const { kit, fixture, element, todayKey } = await open();
    const dates = element.querySelectorAll<HTMLInputElement>('input[type="date"]');
    const end = new Date(`${todayKey}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 2);
    dates[1].value = end.toISOString().slice(0, 10);
    const add = kit.db.outbox.add.bind(kit.db.outbox);
    let calls = 0;
    vi.spyOn(kit.db.outbox, 'add').mockImplementation(((item: never) =>
      ++calls === 1 ? add(item) : Promise.reject(quota())) as never);
    click(element, 'Marcar Ausência');
    await settled(fixture);
    await eventually(fixture, () =>
      expect(element.querySelector('.status')?.textContent).toContain('Só 1 de 3 dias'),
    );
  });

  it('says the note was not saved, instead of "Nota salva", when the device is full', async () => {
    const { kit, fixture, element } = await open();
    vi.spyOn(kit.db.outbox, 'add').mockRejectedValue(quota());
    const area = element.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = 'Texto';
    click(element, 'Salvar Nota');
    await settled(fixture);
    await eventually(fixture, () =>
      expect(element.querySelector('.status')?.textContent).toContain('sem espaço'),
    );
    expect(area.value).toBe('Texto');
  });
});
