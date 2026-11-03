import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, TvItem } from './system-api';
import { SiriApi, SiriApp, SiriKey } from './siri-api';
import { SiriPage } from './siri.page';

const TV_SALA: TvItem = {
  id: 'tv-sala',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: [],
  allowBackgroundAppClosing: false,
};
const TV_QUARTO: TvItem = { ...TV_SALA, id: 'tv-quarto', name: 'Quarto', isDefault: false };

const APP: SiriApp = { id: 'app-1', name: 'Vídeo' };

const KEY: SiriKey = {
  id: 'k1',
  name: 'iPhone do dono',
  tvId: 'tv-sala',
  tvName: 'Sala',
  actions: ['power_off', 'volume_up', 'key:HOME'],
  createdAt: '2026-10-30T10:00:00Z',
  expiresAt: '2027-01-01T00:00:00Z',
  lastUsedAt: null,
};

describe('SiriPage', () => {
  const status = signal<'authenticated' | 'pending'>('authenticated');
  const api = {
    keys: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
    apps: vi.fn(),
  };
  const tvApi = { tvs: vi.fn() };
  const writeText = vi.fn();

  beforeEach(() => {
    status.set('authenticated');
    for (const fn of [...Object.values(api), tvApi.tvs, writeText]) fn.mockReset();
    api.keys.mockResolvedValue([KEY]);
    api.apps.mockResolvedValue([APP]);
    api.revoke.mockResolvedValue(undefined);
    tvApi.tvs.mockResolvedValue([TV_SALA]);
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({
      providers: [
        { provide: SiriApi, useValue: api },
        { provide: SystemApi, useValue: tvApi },
        { provide: SessionState, useValue: { status } },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(SiriPage);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string | RegExp) =>
      Array.from(el.querySelectorAll('button')).find((b) =>
        typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
      );
    const click = async (text: string | RegExp) => {
      const target = button(text);
      expect(target, String(text)).toBeTruthy();
      target!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      // Deixa as respostas simuladas da API (promessas encadeadas) chegarem antes de olhar a tela.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    };
    const toggle = (label: string) => {
      const row = Array.from(el.querySelectorAll('label.option')).find((l) =>
        l.textContent?.includes(label),
      );
      expect(row, label).toBeTruthy();
      const input = row!.querySelector<HTMLInputElement>('input')!;
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    return { fixture, el, button, click, toggle };
  }

  it('lists the keys with the TV, what they do, when they were used and until when they last', async () => {
    const { el } = await render();

    const text = el.textContent ?? '';
    expect(text).toContain('iPhone do dono');
    expect(text).toContain('Sala · Desligar a TV, Aumentar o volume e mais 1');
    expect(text).toContain('Ainda não usada');
    expect(text).toContain('Vale até');
    expect(api.keys).toHaveBeenCalled();
  });

  it('never prints a secret on the list, and the steps of an old key mark where the key goes', async () => {
    const { el, click } = await render();

    await click(/Como montar/);

    const text = el.textContent ?? '';
    expect(text).toContain('<sua chave>');
    expect(text).toContain('X-Atalho-Token');
    expect(text).toContain('/api/v1/shortcuts/tv');
    expect(text).not.toContain('atalho_');
    expect(el.querySelector('button[aria-label="Copiar a chave"]')).toBeNull();
  });

  it('says there is no TV yet, and offers no way to create a key', async () => {
    tvApi.tvs.mockResolvedValue([]);
    api.keys.mockResolvedValue([]);
    const { el, button } = await render();

    expect(el.textContent).toContain('Nenhuma TV configurada ainda');
    expect(button('Criar chave')).toBeUndefined();
  });

  it('hides the create button at the limit of ten keys', async () => {
    api.keys.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ ...KEY, id: `k${i}` })));
    const { el, button } = await render();

    expect(el.textContent).toContain('limite de 10 chaves');
    expect(button('Criar chave')).toBeUndefined();
  });

  it('keeps Create off until there is a name and at least one action', async () => {
    const { el, click, toggle, fixture } = await render();
    await click('Criar chave');

    const submit = () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit().disabled).toBe(true);

    toggle('Mudo');
    expect(submit().disabled).toBe(false);

    const name = el.querySelector<HTMLInputElement>('#siri-name')!;
    name.value = '   ';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(submit().disabled).toBe(true);
  });

  it('offers the apps of the TV, and only for the TV that is chosen', async () => {
    tvApi.tvs.mockResolvedValue([TV_SALA, TV_QUARTO]);
    const { el, click, toggle, fixture } = await render();
    await click('Criar chave');

    expect(api.apps).toHaveBeenCalledWith('tv-sala');
    expect(el.textContent).toContain('Vídeo');
    toggle('Vídeo');
    toggle('Mudo');

    api.apps.mockResolvedValue([]);
    const radios = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="siri-tv"]'));
    expect(radios.length).toBe(2);
    radios[1].dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.apps).toHaveBeenCalledWith('tv-quarto');
    expect(el.textContent).not.toContain('Vídeo');

    api.create.mockResolvedValue({
      id: 'k3',
      name: 'Meu iPhone',
      tvId: 'tv-quarto',
      actions: ['mute'],
      createdAt: '2026-10-31T10:00:00Z',
      expiresAt: null,
      token: 'atalho_x',
    });
    const submit = el.querySelector<HTMLFormElement>('form')!;
    submit.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(api.create).toHaveBeenCalledWith('Meu iPhone', 'tv-quarto', ['mute'], null);
  });

  it('shows the secret once, ready to copy, and drops it when the person finishes', async () => {
    api.create.mockResolvedValue({
      id: 'k2',
      name: 'Meu iPhone',
      tvId: 'tv-sala',
      actions: ['mute', 'app:app-1'],
      createdAt: '2026-10-31T10:00:00Z',
      expiresAt: null,
      token: 'atalho_segredo',
    });
    const { el, click, toggle, fixture } = await render();
    await click('Criar chave');
    toggle('Mudo');
    toggle('Vídeo');
    // O botão do formulário é o de enviar.
    await click('Criar chave');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith('Meu iPhone', 'tv-sala', ['mute', 'app:app-1'], null);
    expect(el.textContent).toContain('Chave criada');
    expect(el.textContent).toContain('ela não aparece de novo');
    expect(el.querySelector<HTMLInputElement>('input.token')!.value).toBe('atalho_segredo');
    expect(el.textContent).toContain('Mudo na TV');
    expect(el.textContent).toContain('Abrir Vídeo na TV');

    await click('Copiar chave');
    expect(writeText).toHaveBeenCalledWith('atalho_segredo');
    expect(el.textContent).toContain('Chave copiada');

    await click('Concluir');
    expect(el.querySelector('input.token')).toBeNull();
    expect(el.textContent).not.toContain('atalho_segredo');
  });

  it('tells when copying is not possible, without losing the key', async () => {
    api.create.mockResolvedValue({
      id: 'k2',
      name: 'Meu iPhone',
      tvId: 'tv-sala',
      actions: ['mute'],
      createdAt: '2026-10-31T10:00:00Z',
      expiresAt: null,
      token: 'atalho_segredo',
    });
    writeText.mockRejectedValue(new Error('bloqueado'));
    const { el, click, toggle, fixture } = await render();
    await click('Criar chave');
    toggle('Mudo');
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();

    await click('Copiar chave');

    expect(el.textContent).toContain('Não deu para copiar sozinho');
    expect(el.querySelector<HTMLInputElement>('input.token')!.value).toBe('atalho_segredo');
  });

  it.each([
    [409, 'Revogue uma antes de criar outra'],
    [403, 'não foi confirmada com a passkey'],
    [500, 'Não foi possível criar a chave'],
  ])('explains a %i from the API in plain words', async (status, expected) => {
    api.create.mockRejectedValue(new HttpErrorResponse({ status }));
    const { el, click, toggle, fixture } = await render();
    await click('Criar chave');
    toggle('Mudo');
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.textContent).toContain(expected);
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('asks before revoking, and after revoking the key is gone from the list', async () => {
    const { el, click, fixture } = await render();
    api.keys.mockResolvedValue([]);

    await click(/Revogar iPhone do dono|Revogar/);
    expect(api.revoke).not.toHaveBeenCalled();
    expect(el.textContent).toContain('param de funcionar');

    el.querySelector<HTMLButtonElement>('.confirm .danger')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.revoke).toHaveBeenCalledWith('k1');
    expect(el.textContent).toContain('Chave revogada');
    expect(el.textContent).not.toContain('iPhone do dono');
  });

  it('can be cancelled while asking to revoke', async () => {
    const { el, click } = await render();

    await click(/Revogar/);
    await click('Cancelar');

    expect(el.querySelector('.confirm')).toBeNull();
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it('shows a plain failure when the keys cannot be loaded', async () => {
    api.keys.mockRejectedValue(new HttpErrorResponse({ status: 500 }));
    const { el } = await render();

    expect(el.textContent).toContain('Não foi possível carregar as chaves');
  });

  it('waits for a confirmed session before asking the API', async () => {
    status.set('pending');
    const fixture = TestBed.createComponent(SiriPage);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.keys).not.toHaveBeenCalled();
  });
});
