import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { catalog, eventually, setupScreen } from '../shell/screen-test-kit';
import { WeekCalendar } from './week-calendar';

describe('WeekCalendar', () => {
  afterEach(() => localStorage.clear());

  it('opens the local summary when a completed workout day is touched', async () => {
    const kit = await setupScreen([{ path: 'treino', component: WeekCalendar }]);
    const finishedAt = kit.runtime.now() - 30 * 60_000;
    await kit.trainingDb.exercises.bulkPut(catalog());
    await kit.trainingDb.sessions.put({
      id: 'past-session',
      routineId: null,
      startedAt: finishedAt - 45 * 60_000,
      finishedAt,
      note: '',
      feeling: null,
      deviceId: 'another-device',
      updatedAt: finishedAt,
      clientUpdatedAt: finishedAt,
      deletedAt: null,
    });
    await kit.trainingDb.sets.put({
      id: 'past-set',
      sessionId: 'past-session',
      exerciseId: 'supino-reto',
      position: 0,
      setType: 'work',
      weightKg: 40,
      reps: 10,
      durationS: null,
      rir: null,
      rpe: null,
      note: '',
      completedAt: finishedAt - 10 * 60_000,
      updatedAt: finishedAt,
      clientUpdatedAt: finishedAt,
      deletedAt: null,
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino', WeekCalendar);
    const fixture = harness.fixture;
    const element = harness.routeNativeElement as HTMLElement;

    await eventually(fixture, () => expect(element.querySelector('.day.done')).not.toBeNull());
    element.querySelector<HTMLButtonElement>('.day.done')!.click();

    expect(navigate).toHaveBeenCalledWith(['/treino'], {
      queryParams: { resumo: 'past-session', historico: '1' },
    });
  });
});
