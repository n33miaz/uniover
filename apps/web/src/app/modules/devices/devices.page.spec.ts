import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../app.routes';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { DeviceAgent, DevicesApi } from './devices-api';
import { DevicesPage } from './devices.page';

const PC: DeviceAgent = {
  id: 'a1',
  slug: 'agent:pc-de-casa',
  name: 'PC de casa',
  platform: 'windows',
  createdAt: '2026-10-18T12:00:00Z',
  revoked: false,
  lastSeenAt: '2026-10-19T09:00:00Z',
};

describe('DevicesPage', () => {
  const api = { list: vi.fn(), approve: vi.fn(), deny: vi.fn(), revoke: vi.fn() };

  beforeEach(() => {
    api.list.mockReset().mockResolvedValue([PC]);
    api.approve.mockReset().mockResolvedValue(undefined);
    api.deny.mockReset().mockResolvedValue(undefined);
    api.revoke.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: DevicesApi, useValue: api }],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(DevicesPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string | RegExp) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
      )!;
    return { fixture, el, button };
  }

  it('lists the paired devices with state and date', async () => {
    const { el } = await render();
    const item = el.querySelector('.item')!;
    expect(item.querySelector('.name')?.textContent).toBe('PC de casa');
    expect(item.textContent).toContain('Pareado em');
    expect(item.textContent).toContain('Ativo');
    expect(item.querySelector('.last-seen')?.textContent).toContain('Último uso em');
  });

  it('says so when the device has no recorded use yet', async () => {
    api.list.mockResolvedValue([{ ...PC, lastSeenAt: null }]);
    const { el } = await render();
    expect(el.querySelector('.last-seen')?.textContent).toContain('Sem uso registrado');
  });

  it('explains the empty state', async () => {
    api.list.mockResolvedValue([]);
    const { el } = await render();
    expect(el.textContent).toContain(
      'Nenhum aparelho pareado. Rode o agente no PC e digite o código que ele mostrar.',
    );
  });

  it('offers a retry when the list cannot be loaded', async () => {
    api.list.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    const { fixture, el, button } = await render();
    expect(el.textContent).toContain('Não foi possível carregar os aparelhos');
    button('Tentar de novo').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.name')?.textContent).toBe('PC de casa');
  });

  it('opens the pairing sheet and, after approving, shows the message and reloads the list', async () => {
    const { fixture, el, button } = await render();
    button('Parear aparelho').click();
    await fixture.whenStable();
    fixture.detectChanges();
    const code = el.querySelector<HTMLInputElement>('#pair-code')!;
    code.value = 'bcdf2345';
    code.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    api.list.mockResolvedValue([PC, { ...PC, id: 'a2', name: 'Notebook' }]);
    button('Aprovar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelectorAll('.item')).toHaveLength(2);
    });
    expect(el.querySelector('app-pair-sheet')).toBeNull();
    expect(el.querySelector('.message')?.textContent).toContain('Aparelho PC de casa pareado.');
  });

  it('confirms inline before revoking and marks the item as revoked', async () => {
    const { fixture, el, button } = await render();
    button('Revogar').click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Revogar o PC de casa? Ele para de receber comandos na hora.');
    expect(api.revoke).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('.danger')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.chip.revoked')).not.toBeNull();
    });
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith('a1');
    expect(el.textContent).toContain('Aparelho revogado.');
    expect(el.querySelector('.item .actions')).toBeNull();
  });

  it('keeps the item when revoking fails and says so', async () => {
    api.revoke.mockRejectedValue(new HttpErrorResponse({ status: 500 }));
    const { fixture, el, button } = await render();
    button('Revogar').click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.danger')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Não foi possível revogar agora.');
    });
    expect(el.querySelector('.chip.active')).not.toBeNull();
  });

  it('disables pairing and revoking without a network, with an explanation', async () => {
    const { fixture, el, button } = await render();
    TestBed.inject(ConnectivityService).online.set(false);
    fixture.detectChanges();
    expect(button('Parear aparelho').disabled).toBe(true);
    expect(button('Revogar').disabled).toBe(true);
    expect(el.textContent).toContain('Sem conexão: parear, recusar e revogar precisam de rede.');
  });
});

describe('devices route', () => {
  it('renders the page lazily, inside the shell, under Ajustes', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: DevicesApi, useValue: { list: () => Promise.resolve([]) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/aparelhos');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector('app-devices-page')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Aparelhos');
  });
});
