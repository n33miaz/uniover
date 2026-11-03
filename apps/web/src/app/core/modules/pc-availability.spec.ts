import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SessionState } from '../session/session-state';
import { PC_STATUS_PATH, PcAvailability, parsePcStatus } from './pc-availability';

describe('parsePcStatus', () => {
  it('reads a well-formed answer', () => {
    expect(
      parsePcStatus({ available: true, online: false, apps: [{ id: 'notas', label: 'Notas' }] }),
    ).toEqual({ available: true, online: false, apps: [{ id: 'notas', label: 'Notas' }] });
  });

  it('never invents a computer from a malformed body', () => {
    expect(parsePcStatus(null)).toBeNull();
    expect(parsePcStatus('x')).toBeNull();
    expect(parsePcStatus({ available: 'yes', online: true })).toBeNull();
    expect(parsePcStatus({ available: true })).toBeNull();
  });

  it('drops favorites that are not an id with a label', () => {
    const status = parsePcStatus({
      available: true,
      online: true,
      apps: [{ id: 'ok', label: 'Ok' }, { id: 5, label: 'x' }, null, { label: 'sem id' }],
    });
    expect(status?.apps).toEqual([{ id: 'ok', label: 'Ok' }]);
  });
});

describe('PcAvailability', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('states nothing before the first answer: the card stays as planned', () => {
    const availability = TestBed.inject(PcAvailability);
    expect(availability.status()).toBeNull();
    expect(availability.available()).toBe(false);
    expect(availability.apps()).toEqual([]);
  });

  it('reads the status from the API', async () => {
    const availability = TestBed.inject(PcAvailability);
    const refreshed = availability.refresh();
    http.expectOne(PC_STATUS_PATH).flush({ available: true, online: true, apps: [] });
    expect(await refreshed).toBe(true);
    expect(availability.available()).toBe(true);
    expect(availability.online()).toBe(true);
  });

  it('keeps the previous state when the API does not answer', async () => {
    const availability = TestBed.inject(PcAvailability);
    const first = availability.refresh();
    http.expectOne(PC_STATUS_PATH).flush({ available: true, online: false, apps: [] });
    await first;

    const second = availability.refresh();
    http.expectOne(PC_STATUS_PATH).flush({}, { status: 503, statusText: 'x' });
    expect(await second).toBe(false);
    expect(availability.available()).toBe(true);
  });

  it('a body in an unexpected format counts as no answer', async () => {
    const availability = TestBed.inject(PcAvailability);
    const refreshed = availability.refresh();
    http.expectOne(PC_STATUS_PATH).flush({ nope: true });
    expect(await refreshed).toBe(false);
    expect(availability.status()).toBeNull();
  });

  function signIn(id: string) {
    TestBed.inject(SessionState).setUser({
      id,
      email: `${id}@exemplo.com`,
      displayName: id,
      role: 'owner',
    });
  }

  it('an answer that left one account and arrives after the tab switched to another is discarded', async () => {
    const availability = TestBed.inject(PcAvailability);
    signIn('conta-a');
    TestBed.tick();
    const refreshed = availability.refresh();
    const pending = http.expectOne(PC_STATUS_PATH);

    signIn('conta-b');
    TestBed.tick();
    pending.flush({ available: true, online: true, apps: [{ id: 'segredo-de-a', label: 'Do A' }] });

    expect(await refreshed).toBe(false);
    expect(availability.status()).toBeNull();
    expect(availability.apps()).toEqual([]);
  });

  it('an answer for the same account is still applied', async () => {
    const availability = TestBed.inject(PcAvailability);
    signIn('conta-a');
    const refreshed = availability.refresh();
    http.expectOne(PC_STATUS_PATH).flush({ available: true, online: false, apps: [] });
    expect(await refreshed).toBe(true);
    expect(availability.available()).toBe(true);
  });

  it('works where no HTTP client was provided (nothing breaks, nothing is claimed)', async () => {
    TestBed.resetTestingModule();
    const availability = TestBed.inject(PcAvailability);
    expect(await availability.refresh()).toBe(false);
    expect(availability.available()).toBe(false);
  });
});
