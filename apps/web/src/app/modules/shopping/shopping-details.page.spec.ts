import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiProblem } from '../../core/auth/api-problem';
import { SessionState } from '../../core/session/session-state';
import { IMPORT_POLL_MS, ShoppingDetailsPage } from './shopping-details.page';
import { ShoppingPeopleApi } from './shopping-people-api';
import { ShoppingSession } from './shopping-session';

const IMPORT = '/api/v1/shopping/import/economize';

describe('ShoppingDetailsPage', () => {
  let fixture: ComponentFixture<ShoppingDetailsPage>;
  let el: HTMLElement;
  let http: HttpTestingController;
  let people: {
    isOwner: boolean;
    revoked: string[];
    createFails: unknown;
  };

  async function render(role: 'owner' | 'guest' = 'owner'): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SessionState, useValue: { role: signal(role) } },
        { provide: ShoppingSession, useValue: { store: signal(null) } },
        {
          provide: ShoppingPeopleApi,
          useValue: {
            group: async () => ({ id: 'g1', isOwner: people.isOwner }),
            people: async () => [{ userId: 'me', name: 'Neemias', isOwner: true, isMember: true }],
            createInvite: async () => {
              if (people.createFails) throw people.createFails;
              return { id: 'inv-1', token: 'segredo_do_convite_123456', expiresAt: '2026-11-19' };
            },
            revokeInvite: async (id: string) => {
              people.revoked.push(id);
            },
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ShoppingDetailsPage);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  async function settle(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      await fixture.whenStable();
      fixture.detectChanges();
      await Promise.resolve();
    }
  }

  const text = (): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.replace(/\s+/g, ' ').trim().startsWith(label),
    );

  beforeEach(() => {
    people = { isOwner: true, revoked: [], createFails: null };
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('the group owner makes an invite and shows its QR and link; cancelling drops it', async () => {
    await render();
    button('Gerar convite')!.click();
    await settle();

    expect(el.querySelector('app-qr-code svg')).not.toBeNull();
    expect(text()).toContain('Vale 7 dias');
    button('Cancelar convite')!.click();
    await settle();
    expect(people.revoked).toEqual(['inv-1']);
    expect(el.querySelector('app-qr-code')).toBeNull();
  });

  it('says plainly when there are too many invites waiting', async () => {
    people.createFails = new ApiProblem(409, 'shopping-too-many-invites', 'x');
    await render();
    button('Gerar convite')!.click();
    await settle();
    expect(text()).toContain('Há convites demais esperando');
  });

  it('a member who did not create the group sees no invite, and a guest sees no Economize', async () => {
    people.isOwner = false;
    await render('guest');
    expect(button('Gerar convite')).toBeUndefined();
    expect(text()).not.toContain('Economize');
  });

  it('fetches from the Economize and follows the progress every 2 s until it finishes', async () => {
    await render();
    vi.useFakeTimers();
    button('Buscar no Economize')!.click();
    await vi.advanceTimersByTimeAsync(0);
    http
      .expectOne({ method: 'POST', url: IMPORT })
      .flush(null, { status: 202, statusText: 'Accepted' });
    await vi.advanceTimersByTimeAsync(0);
    http
      .expectOne({ method: 'GET', url: IMPORT })
      .flush({ running: true, finished: false, imported: 3, existing: 0, ignored: 0, error: null });
    await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS);
    http.expectOne({ method: 'GET', url: IMPORT }).flush({
      running: false,
      finished: true,
      imported: 12,
      existing: 4,
      ignored: 1,
      error: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();

    expect(text()).toContain('12 compras trazidas, 4 já existiam.');
  });

  it('hides the fetch when the integration is off, keeping the file', async () => {
    await render();
    button('Buscar no Economize')!.click();
    await settle();
    http
      .expectOne({ method: 'POST', url: IMPORT })
      .flush(null, { status: 202, statusText: 'Accepted' });
    await settle();
    http.expectOne({ method: 'GET', url: IMPORT }).flush({
      running: false,
      finished: true,
      imported: 0,
      existing: 0,
      ignored: 0,
      error: 'disabled',
    });
    await settle();

    expect(button('Buscar no Economize')).toBeUndefined();
    expect(text()).toContain('Escolher arquivo');
  });

  it.each([
    [400, 'fora do formato'],
    [413, 'passa de 2 MB'],
    [409, 'não está mais neste grupo'],
  ])('a file refused with %s is explained in plain words', async (status, message) => {
    await render();
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['{"trips":[]}'], 'compras.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = http.expectOne({ method: 'POST', url: `${IMPORT}/file` });
    expect(request.request.body).toEqual({ trips: [] });
    request.flush({ title: 'x' }, { status, statusText: 'Refused' });
    await settle();

    expect(text()).toContain(message);
  });

  it('a file that is not JSON never leaves the phone', async () => {
    await render();
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['isto não é json'], 'compras.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();

    expect(text()).toContain('não é a exportação de compras do Economize');
  });
});
