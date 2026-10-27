import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { ApiProblem, networkProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { AuditApi } from './audit-api';
import { AuditDownload } from './audit-download';
import { AuditItem, AuditSources, EMPTY_QUERY } from './audit-model';
import { AuditPage } from './audit.page';

@Component({ template: '' })
class Blank {}

const SOURCES: AuditSources = {
  outcomes: ['success', 'failure', 'denied'],
  sources: [
    { module: 'devices', retentionDays: 180, actions: ['pairing_approved'] },
    { module: 'identity', retentionDays: 180, actions: ['login_succeeded', 'login_failed'] },
    { module: 'tv', retentionDays: 30, actions: ['tv.key', 'tv.power-off'] },
  ],
};

const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

function entry(n: number, overrides: Partial<AuditItem> = {}): AuditItem {
  return {
    id: `id-${n}`,
    module: 'identity',
    action: 'login_succeeded',
    outcome: 'success',
    occurredAt: new Date(2026, 9, 21, 14, 59 - n).toISOString(),
    actor: { id: 'eu', displayName: 'Dono da Casa' },
    target: null,
    targetAccount: null,
    detail: null,
    ip: '203.0.113.7',
    userAgent: SAFARI_IPHONE,
    ...overrides,
  };
}

/** Uma promessa que o teste resolve quando quiser (para provar a ordem em que as respostas chegam). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function problem(status: number): ApiProblem {
  return new ApiProblem(status, 'x', `HTTP ${status}`);
}

describe('AuditPage', () => {
  const api = { sources: vi.fn(), list: vi.fn(), export: vi.fn(), guests: vi.fn() };
  const authApi = { me: vi.fn() };
  const download = { save: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    for (const fn of [...Object.values(api), ...Object.values(authApi), download.save]) {
      fn.mockReset();
    }
    api.sources.mockResolvedValue(SOURCES);
    api.list.mockResolvedValue({ items: [entry(1), entry(2)], nextCursor: null });
    api.guests.mockResolvedValue([{ id: 'g1', name: 'Bruno' }]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '', component: Blank }]),
        { provide: AuditApi, useValue: api },
        { provide: AuthApi, useValue: authApi },
        { provide: AuditDownload, useValue: download },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  function signIn(role: 'owner' | 'guest' | null = 'owner') {
    const session = TestBed.inject(SessionState);
    if (role) {
      session.setToken('t', 600);
      session.setUser({
        id: 'eu',
        email: 'dono@exemplo.com',
        displayName: 'Dono da Casa',
        role,
        permissions: [],
      });
    }
    return session;
  }

  async function settle(fixture: ComponentFixture<AuditPage>) {
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function render() {
    const fixture = TestBed.createComponent(AuditPage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
    const rows = () => Array.from(el.querySelectorAll<HTMLButtonElement>('button.entry'));
    const button = (label: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent?.trim() === label,
      )!;
    const chips = () =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('.applied-chip')).map((chip) =>
        chip.textContent?.trim(),
      );
    // O nome do botão ganha o número de filtros ligados: por isso é achado pelo papel, não pelo texto.
    const filtersButton = () =>
      el.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    return { fixture, el, text, rows, button, chips, filtersButton };
  }

  /** Abre a folha, aplica o filtro por esta ação e espera a lista recarregar. */
  async function applyOutcome(t: Awaited<ReturnType<typeof render>>, label: string) {
    t.filtersButton().click();
    t.fixture.detectChanges();
    await settle(t.fixture);
    const choice = Array.from(t.el.querySelectorAll<HTMLLabelElement>('label.choice')).find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
    choice.querySelector('input')!.click();
    t.fixture.detectChanges();
    t.el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle(t.fixture);
  }

  describe('who may load it', () => {
    it('loads the sources and the first page for the administrator, and nothing else', async () => {
      signIn();
      await render();
      expect(api.sources).toHaveBeenCalledTimes(1);
      expect(api.list).toHaveBeenCalledExactlyOnceWith(EMPTY_QUERY);
      expect(api.guests).not.toHaveBeenCalled();
      expect(api.export).not.toHaveBeenCalled();
    });

    it.each([
      ['a guest', 'guest' as const],
      ['nobody', null],
    ])('never calls the API for %s', async (_who, role) => {
      signIn(role);
      await render();
      expect(api.sources).not.toHaveBeenCalled();
      expect(api.list).not.toHaveBeenCalled();
      expect(api.guests).not.toHaveBeenCalled();
    });

    it('waits for the session to be confirmed and then loads', async () => {
      const session = signIn(null);
      const { fixture } = await render();
      expect(api.list).not.toHaveBeenCalled();
      session.setToken('t', 600);
      session.setUser({ id: 'eu', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
      await settle(fixture);
      expect(api.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('the list', () => {
    it('shows who, what, the result and when on each row, in words', async () => {
      signIn();
      api.list.mockResolvedValue({
        items: [
          entry(1),
          entry(2, {
            action: 'login_failed',
            outcome: 'failure',
            actor: { id: 'g9', displayName: null },
          }),
          entry(3, { module: 'tv', action: 'tv.power-off', outcome: 'denied', actor: null }),
        ],
        nextCursor: null,
      });
      const { rows, el } = await render();
      const parts = rows().map((row) => ({
        title: row.querySelector('.ui-row-title')?.textContent?.trim(),
        who: row.querySelector('.ui-row-sub')?.textContent?.split('·')[0].trim(),
        result: row.querySelector('.result')?.textContent?.trim(),
      }));
      expect(parts).toEqual([
        { title: 'Entrou na conta', who: 'Dono da Casa', result: 'Sucesso' },
        { title: 'Tentou entrar', who: 'Conta apagada', result: 'Erro' },
        { title: 'TV desligada', who: 'Sem conta', result: 'Recusado' },
      ]);
      // O resultado também tem forma própria (ícone), não só texto e cor.
      expect(
        rows().map((row) =>
          row.querySelector('.result app-settings-glyph path.line')?.getAttribute('d'),
        ),
      ).toSatisfy((shapes: (string | null | undefined)[]) => new Set(shapes).size === 3);
      expect(el.textContent).not.toContain('@');
      expect(el.textContent).not.toMatch(/login_failed|tv\.power-off/);
    });

    it('keeps IP and device behind a tap: the row alone does not show them', async () => {
      signIn();
      const { el, rows } = await render();
      expect(el.textContent).not.toContain('203.0.113.7');
      expect(el.textContent).not.toContain('Safari');
      expect(rows()[0].getAttribute('aria-expanded')).toBe('false');
    });

    it('opens the details of a row on tap: IP, a short device, the target and the source', async () => {
      signIn();
      api.list.mockResolvedValue({
        items: [
          entry(1, {
            module: 'tv',
            action: 'tv.text',
            target: 'length=6',
            userAgent: SAFARI_IPHONE,
          }),
        ],
        nextCursor: null,
      });
      const { fixture, el, rows } = await render();
      rows()[0].click();
      fixture.detectChanges();

      expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
      const details = el.querySelector('dl.details')!;
      expect(rows()[0].getAttribute('aria-controls')).toBe(details.id);
      const lines = Array.from(details.querySelectorAll('.line')).map((line) => [
        line.querySelector('dt')?.textContent?.trim(),
        line.querySelector('dd')?.textContent?.trim(),
      ]);
      expect(lines).toEqual([
        ['Alvo', '6 caracteres'],
        ['Módulo', 'TV'],
        ['IP', '203.0.113.7'],
        ['Aparelho', 'Safari no iPhone'],
      ]);
      // Nunca o user-agent inteiro.
      expect(el.textContent).not.toContain('AppleWebKit');
    });

    it('says "Não registrado" when the IP or the device was not recorded', async () => {
      signIn();
      api.list.mockResolvedValue({
        items: [entry(1, { ip: null, userAgent: null })],
        nextCursor: null,
      });
      const { fixture, el, rows } = await render();
      rows()[0].click();
      fixture.detectChanges();
      const values = Array.from(el.querySelectorAll('.line dd')).map((dd) =>
        dd.textContent?.trim(),
      );
      expect(values).toEqual(['Conta e acesso', 'Não registrado', 'Não registrado']);
    });

    it('opens one row at a time and closes it with a second tap', async () => {
      signIn();
      const { fixture, el, rows } = await render();
      rows()[0].click();
      fixture.detectChanges();
      rows()[1].click();
      fixture.detectChanges();
      expect(rows().map((row) => row.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
      expect(el.querySelectorAll('dl.details')).toHaveLength(1);
      rows()[1].click();
      fixture.detectChanges();
      expect(rows()[1].getAttribute('aria-expanded')).toBe('false');
    });

    it('says the retention and the privacy sentence, calmly', async () => {
      signIn();
      const { text } = await render();
      expect(text()).toContain(
        'Estes registros ficam guardados por segurança: data, IP e aparelho de cada ação.',
      );
      expect(text()).toContain('Guardamos por 180 dias (TV: 30 dias)');
    });

    it('lists even when the sources failed: only the retention line and the module options are missing', async () => {
      signIn();
      api.sources.mockRejectedValue(networkProblem());
      const { text, rows } = await render();
      expect(rows()).toHaveLength(2);
      expect(text()).not.toContain('Guardamos por');
    });
  });

  describe('load more', () => {
    it('follows the cursor, appends the next page and drops the button at the end', async () => {
      signIn();
      api.list
        .mockResolvedValueOnce({ items: [entry(1), entry(2)], nextCursor: 'c1' })
        .mockResolvedValueOnce({ items: [entry(3)], nextCursor: null });
      const { fixture, rows, button } = await render();
      expect(rows()).toHaveLength(2);

      button('Carregar mais').click();
      await settle(fixture);

      expect(api.list).toHaveBeenLastCalledWith(EMPTY_QUERY, 'c1');
      expect(rows()).toHaveLength(3);
      expect(
        Array.from(fixture.nativeElement.querySelectorAll('button')).some(
          (b) => (b as HTMLElement).textContent?.trim() === 'Carregar mais',
        ),
      ).toBe(false);
    });

    it('never repeats a row that comes back on the next page', async () => {
      signIn();
      api.list
        .mockResolvedValueOnce({ items: [entry(1), entry(2)], nextCursor: 'c1' })
        .mockResolvedValueOnce({ items: [entry(2), entry(3)], nextCursor: null });
      const { fixture, rows, button } = await render();
      button('Carregar mais').click();
      await settle(fixture);
      expect(rows()).toHaveLength(3);
    });

    it('does not fire twice while a page is on its way', async () => {
      signIn();
      const next = deferred<{ items: AuditItem[]; nextCursor: string | null }>();
      api.list
        .mockResolvedValueOnce({ items: [entry(1)], nextCursor: 'c1' })
        .mockReturnValueOnce(next.promise);
      const { fixture, button } = await render();
      button('Carregar mais').click();
      fixture.detectChanges();
      expect(button('Carregando…').disabled).toBe(true);
      button('Carregando…').click();
      expect(api.list).toHaveBeenCalledTimes(2);
      next.resolve({ items: [], nextCursor: null });
      await settle(fixture);
    });

    it('keeps what is already on the screen when a page fails, and lets the person try again', async () => {
      signIn();
      api.list
        .mockResolvedValueOnce({ items: [entry(1), entry(2)], nextCursor: 'c1' })
        .mockRejectedValueOnce(problem(500))
        .mockResolvedValueOnce({ items: [entry(3)], nextCursor: null });
      const { fixture, rows, text, button } = await render();

      button('Carregar mais').click();
      await settle(fixture);
      expect(rows()).toHaveLength(2);
      expect(text()).toContain('Não foi possível carregar mais registros agora.');

      button('Tentar de novo').click();
      await settle(fixture);
      expect(rows()).toHaveLength(3);
      expect(text()).not.toContain('Não foi possível carregar mais');
    });
  });

  describe('filters', () => {
    it('loads the people only when the sheet opens, once', async () => {
      signIn();
      const t = await render();
      expect(api.guests).not.toHaveBeenCalled();
      t.filtersButton().click();
      t.fixture.detectChanges();
      await settle(t.fixture);
      expect(api.guests).toHaveBeenCalledTimes(1);
      const options = Array.from(t.el.querySelectorAll('input[name="audit-filter-person"]')).map(
        (input) => input.closest('label')?.textContent?.trim(),
      );
      expect(options).toEqual(['Todas as pessoas', 'Dono da Casa (você)', 'Bruno']);
    });

    it('reloads the list from the first page with the filter, and shows it as a chip that is one tap to clear', async () => {
      signIn();
      const t = await render();
      api.list.mockClear();
      api.list.mockResolvedValue({ items: [entry(7, { outcome: 'failure' })], nextCursor: null });

      await applyOutcome(t, 'Erro');

      expect(api.list).toHaveBeenCalledExactlyOnceWith({ ...EMPTY_QUERY, outcome: 'failure' });
      expect(t.chips()).toEqual(['Resultado: Erro']);
      expect(t.el.querySelector('.applied-chip')?.getAttribute('aria-label')).toBe(
        'Remover filtro: Resultado: Erro',
      );
      // Sem aria-label: o nome vem do que se vê ("Filtros" e o número), e o nome acessível nunca destoa do texto do botão.
      expect(t.filtersButton().hasAttribute('aria-label')).toBe(false);
      expect(t.filtersButton().textContent?.replace(/\s+/g, ' ').trim()).toBe('Filtros 1');

      api.list.mockClear();
      api.list.mockResolvedValue({ items: [entry(1)], nextCursor: null });
      t.el.querySelector<HTMLButtonElement>('.applied-chip')!.click();
      await settle(t.fixture);
      expect(api.list).toHaveBeenCalledExactlyOnceWith(EMPTY_QUERY);
      expect(t.chips()).toEqual([]);
    });

    it('turns the period into a fixed start that the next pages and the export reuse', async () => {
      signIn();
      api.list.mockResolvedValue({ items: [entry(1)], nextCursor: 'c1' });
      const t = await render();
      t.filtersButton().click();
      t.fixture.detectChanges();
      await settle(t.fixture);
      Array.from(t.el.querySelectorAll<HTMLLabelElement>('label.choice'))
        .find((label) => label.textContent?.trim() === 'Últimos 7 dias')!
        .querySelector('input')!
        .click();
      t.fixture.detectChanges();
      t.el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await settle(t.fixture);

      const first = api.list.mock.calls.at(-1)![0];
      expect(first.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      t.button('Carregar mais').click();
      await settle(t.fixture);
      expect(api.list.mock.calls.at(-1)![0].from).toBe(first.from);

      api.export.mockResolvedValue({ blob: new Blob(['x']), truncated: false, filename: null });
      t.button('Exportar CSV').click();
      await settle(t.fixture);
      expect(api.export.mock.calls[0][0].from).toBe(first.from);
    });

    it('clears everything at once from the chip row', async () => {
      signIn();
      const t = await render();
      await applyOutcome(t, 'Recusado');
      expect(t.chips()).toHaveLength(1);
      expect(t.el.querySelector('.clear-all')).toBeNull();

      t.filtersButton().click();
      t.fixture.detectChanges();
      await settle(t.fixture);
      Array.from(t.el.querySelectorAll<HTMLLabelElement>('label.choice'))
        .find((label) => label.textContent?.trim() === 'Últimas 24 horas')!
        .querySelector('input')!
        .click();
      t.fixture.detectChanges();
      t.el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await settle(t.fixture);
      expect(t.chips()).toEqual(['Resultado: Recusado', 'Últimas 24 horas']);

      api.list.mockClear();
      t.button('Limpar tudo').click();
      await settle(t.fixture);
      expect(api.list).toHaveBeenCalledExactlyOnceWith(EMPTY_QUERY);
      expect(t.chips()).toEqual([]);
    });

    it('throws away a late answer of the old filter: it never lands in the new list', async () => {
      signIn();
      const slow = deferred<{ items: AuditItem[]; nextCursor: string | null }>();
      api.list.mockReset();
      api.list
        .mockResolvedValueOnce({ items: [entry(1)], nextCursor: null })
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce({ items: [entry(5), entry(6)], nextCursor: null });
      const t = await render();

      // O primeiro filtro (ainda sem resposta) e, por cima dele, o segundo.
      await applyOutcome(t, 'Erro');
      t.filtersButton().click();
      t.fixture.detectChanges();
      await settle(t.fixture);
      Array.from(t.el.querySelectorAll<HTMLLabelElement>('label.choice'))
        .find((label) => label.textContent?.trim() === 'Recusado')!
        .querySelector('input')!
        .click();
      t.fixture.detectChanges();
      t.el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await settle(t.fixture);
      expect(t.rows()).toHaveLength(2);

      slow.resolve({ items: [entry(9), entry(10), entry(11)], nextCursor: 'velho' });
      await settle(t.fixture);
      expect(t.rows()).toHaveLength(2);
      expect(t.el.textContent).not.toContain('Carregar mais');
    });

    it('says "Nenhum registro com esses filtros" and offers to clear them', async () => {
      signIn();
      const t = await render();
      api.list.mockResolvedValue({ items: [], nextCursor: null });
      await applyOutcome(t, 'Erro');
      expect(t.text()).toContain('Nenhum registro com esses filtros.');
      api.list.mockResolvedValue({ items: [entry(1)], nextCursor: null });
      t.button('Limpar tudo').click();
      await settle(t.fixture);
      expect(t.rows()).toHaveLength(1);
    });

    it('says there are no records yet when nothing is filtered', async () => {
      signIn();
      api.list.mockResolvedValue({ items: [], nextCursor: null });
      const { text } = await render();
      expect(text()).toContain('Ainda não há registros.');
      expect(text()).not.toContain('com esses filtros');
    });
  });

  describe('when it cannot load', () => {
    it('shows the error and tries again on request', async () => {
      signIn();
      api.list.mockRejectedValueOnce(problem(500));
      const { fixture, text, rows, button } = await render();
      expect(text()).toContain('Não foi possível carregar os registros agora.');
      expect(rows()).toHaveLength(0);

      button('Tentar de novo').click();
      await settle(fixture);
      expect(rows()).toHaveLength(2);
      expect(text()).not.toContain('Não foi possível carregar os registros');
    });

    it('explains calmly that it needs the internet when the request has no answer, and comes back by itself', async () => {
      signIn();
      api.list.mockRejectedValueOnce(networkProblem());
      const { fixture, text, rows } = await render();
      expect(text()).toContain('A auditoria só funciona com internet');
      expect(text()).not.toContain('Não foi possível');

      TestBed.inject(ConnectivityService).online.set(false);
      TestBed.inject(ConnectivityService).online.set(true);
      await settle(fixture);
      expect(rows()).toHaveLength(2);
    });

    it('does not even ask while the device is offline, and shows the same calm message', async () => {
      signIn();
      TestBed.inject(ConnectivityService).online.set(false);
      const { text, button } = await render();
      expect(api.list).not.toHaveBeenCalled();
      expect(text()).toContain('A auditoria só funciona com internet');
      expect(button('Exportar CSV').disabled).toBe(true);
    });

    it('sends the person to the Início, like the other administrator screens, when the server says 403 and the role changed', async () => {
      signIn();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      api.list.mockRejectedValueOnce(problem(403));
      authApi.me.mockResolvedValue({
        id: 'eu',
        email: 'dono@exemplo.com',
        displayName: 'Dono da Casa',
        role: 'guest',
        permissions: ['module:tv', 'tv:control'],
      });
      const { text } = await render();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replaceUrl: true }));
      expect(authApi.me).toHaveBeenCalledTimes(1);
      expect(text()).not.toContain('Não foi possível');
    });

    it('leads a guest who only has the training to the Início too, where the training card waits', async () => {
      signIn();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      api.list.mockRejectedValueOnce(problem(403));
      authApi.me.mockResolvedValue({
        id: 'eu',
        email: 'dono@exemplo.com',
        displayName: 'Dono da Casa',
        role: 'guest',
        permissions: ['module:training'],
      });
      await render();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replaceUrl: true }));
      expect(navigate).not.toHaveBeenCalledWith('/treino', expect.anything());
    });

    it('shows the common error, and never loops, when a 403 comes but the role is still administrator', async () => {
      signIn();
      api.list.mockRejectedValueOnce(problem(403));
      authApi.me.mockResolvedValue({
        id: 'eu',
        email: 'dono@exemplo.com',
        displayName: 'Dono da Casa',
        role: 'owner',
        permissions: [],
      });
      const { text } = await render();
      expect(text()).toContain('Não foi possível carregar os registros agora.');
      expect(TestBed.inject(Router).url).toBe('/');
      expect(api.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('export', () => {
    it('downloads the CSV of the same filters under the name the server suggests, and says it was registered', async () => {
      signIn();
      api.export.mockResolvedValue({
        blob: new Blob(['a;b']),
        truncated: false,
        filename: 'auditoria-20261021-1500.csv',
      });
      const t = await render();
      await applyOutcome(t, 'Erro');

      t.button('Exportar CSV').click();
      await settle(t.fixture);

      expect(api.export).toHaveBeenCalledExactlyOnceWith({ ...EMPTY_QUERY, outcome: 'failure' });
      expect(download.save).toHaveBeenCalledTimes(1);
      expect(download.save.mock.calls[0][1]).toBe('auditoria-20261021-1500.csv');
      expect(t.text()).toContain('Arquivo baixado. Esta exportação ficou registrada na auditoria.');
    });

    it('uses a name of its own when the server sends none', async () => {
      signIn();
      api.export.mockResolvedValue({ blob: new Blob(['x']), truncated: false, filename: null });
      const t = await render();
      t.button('Exportar CSV').click();
      await settle(t.fixture);
      expect(download.save.mock.calls[0][1]).toMatch(/^auditoria-\d{8}-\d{4}\.csv$/);
    });

    it('warns when the server cut the file, and still downloads what came', async () => {
      signIn();
      api.export.mockResolvedValue({ blob: new Blob(['x']), truncated: true, filename: null });
      const t = await render();
      t.button('Exportar CSV').click();
      await settle(t.fixture);
      expect(download.save).toHaveBeenCalledTimes(1);
      expect(t.text()).toContain('O arquivo traz só os registros mais recentes');
      expect(t.el.querySelector('.ui-notice.warn')).not.toBeNull();
    });

    it('tells apart the filters the server refused, the lost connection and any other failure', async () => {
      signIn();
      const t = await render();
      for (const [error, expected] of [
        [problem(400), 'Esses filtros não foram aceitos'],
        [networkProblem(), 'Sem conexão com o servidor'],
        [problem(429), 'Muitas tentativas seguidas'],
        [problem(500), 'Não foi possível exportar agora'],
      ] as const) {
        api.export.mockRejectedValueOnce(error);
        t.button('Exportar CSV').click();
        await settle(t.fixture);
        expect(t.text()).toContain(expected);
        expect(t.el.querySelector('.ui-notice.bad')?.getAttribute('role')).toBe('alert');
      }
      expect(download.save).not.toHaveBeenCalled();
    });

    it('does not start a second export while one is running', async () => {
      signIn();
      const file = deferred<{ blob: Blob; truncated: boolean; filename: string | null }>();
      api.export.mockReturnValue(file.promise);
      const t = await render();
      t.button('Exportar CSV').click();
      t.fixture.detectChanges();
      expect(t.button('Exportando…').disabled).toBe(true);
      file.resolve({ blob: new Blob(['x']), truncated: false, filename: null });
      await settle(t.fixture);
      expect(api.export).toHaveBeenCalledTimes(1);
    });

    it('also leaves, to the Início, when the export is refused with 403 because the role changed', async () => {
      signIn();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      api.export.mockRejectedValueOnce(problem(403));
      authApi.me.mockResolvedValue({
        id: 'eu',
        email: 'dono@exemplo.com',
        displayName: 'Dono da Casa',
        role: 'guest',
        permissions: ['module:tv'],
      });
      const t = await render();
      t.button('Exportar CSV').click();
      await settle(t.fixture);
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replaceUrl: true }));
    });
  });

  it('writes nothing to the console while loading, opening a row and exporting (IP and device are never logged)', async () => {
    signIn();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    api.export.mockResolvedValue({ blob: new Blob(['x']), truncated: false, filename: null });
    try {
      const t = await render();
      t.rows()[0].click();
      t.fixture.detectChanges();
      t.button('Exportar CSV').click();
      await settle(t.fixture);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
