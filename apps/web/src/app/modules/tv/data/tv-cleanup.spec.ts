import { CLEANUP_FREED_MIN_MB, describeCleanup, freedMegabytes } from './tv-cleanup';

const result = (overrides: Partial<Parameters<typeof describeCleanup>[0]> = {}) => ({
  closedApps: 6,
  freedMb: 383,
  failedSteps: [] as string[],
  ...overrides,
});

describe('describeCleanup', () => {
  it('says how many apps closed and about how much memory was freed', () => {
    expect(describeCleanup(result())).toBe('Fechou 6 apps e liberou cerca de 380 MB.');
  });

  it('uses the singular for one app', () => {
    expect(describeCleanup(result({ closedApps: 1 }))).toBe(
      'Fechou 1 app e liberou cerca de 380 MB.',
    );
    expect(describeCleanup(result({ closedApps: 1, freedMb: null }))).toBe('Fechou 1 app.');
  });

  it('says only the apps when the memory could not be measured', () => {
    expect(describeCleanup(result({ freedMb: null }))).toBe('Fechou 6 apps.');
  });

  it('says there was nothing to close when no app closed and nothing was freed', () => {
    expect(describeCleanup(result({ closedApps: 0, freedMb: null }))).toBe('Nada para fechar.');
    expect(describeCleanup(result({ closedApps: 0, freedMb: 0 }))).toBe('Nada para fechar.');
  });

  it('still says what was freed by the background cleanup when no app was open', () => {
    expect(describeCleanup(result({ closedApps: 0, freedMb: 120 }))).toBe(
      'Liberou cerca de 120 MB.',
    );
  });

  it('does not promise a few megabytes: tiny numbers are noise of the memory reading', () => {
    expect(describeCleanup(result({ freedMb: CLEANUP_FREED_MIN_MB - 1 }))).toBe('Fechou 6 apps.');
    expect(describeCleanup(result({ freedMb: CLEANUP_FREED_MIN_MB }))).toBe(
      'Fechou 6 apps e liberou cerca de 20 MB.',
    );
  });

  it('admits when some steps failed, without hiding what worked', () => {
    expect(describeCleanup(result({ failedSteps: ['force-stop:com.exemplo.player'] }))).toBe(
      'Fechou 6 apps e liberou cerca de 380 MB. Algumas etapas não deram certo.',
    );
    expect(
      describeCleanup(result({ closedApps: 0, freedMb: null, failedSteps: ['go-home'] })),
    ).toBe('Nada para fechar. Algumas etapas não deram certo.');
  });

  it('tolerates a report without the list of failed steps', () => {
    expect(
      describeCleanup({ closedApps: 2, freedMb: null } as Parameters<typeof describeCleanup>[0]),
    ).toBe('Fechou 2 apps.');
  });
});

describe('freedMegabytes', () => {
  it('rounds to the nearest ten and ignores what is not a usable number', () => {
    expect(freedMegabytes({ freedMb: 383 })).toBe(380);
    expect(freedMegabytes({ freedMb: 385 })).toBe(390);
    expect(freedMegabytes({ freedMb: null })).toBeNull();
    expect(freedMegabytes({ freedMb: -50 })).toBeNull();
    expect(freedMegabytes({ freedMb: Number.NaN })).toBeNull();
  });
});
