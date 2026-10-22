import { TestBed } from '@angular/core/testing';
import { AuditFilterSheet } from './audit-filter-sheet';
import { AuditFilter, AuditPerson, AuditSources, EMPTY_FILTER } from './audit-model';

const SOURCES: AuditSources = {
  outcomes: ['success', 'failure', 'denied'],
  sources: [
    { module: 'devices', retentionDays: 180, actions: ['pairing_approved', 'agent_revoked'] },
    {
      module: 'identity',
      retentionDays: 180,
      actions: ['login_succeeded', 'login_failed', 'novo'],
    },
    { module: 'tv', retentionDays: 30, actions: ['tv.key', 'tv.power-off'] },
  ],
};
const PEOPLE: readonly AuditPerson[] = [
  { id: 'eu', name: 'Dono da Casa' },
  { id: 'g1', name: 'Bruno' },
];

interface Setup {
  readonly filter?: AuditFilter;
  readonly sources?: AuditSources | null;
  readonly people?: readonly AuditPerson[] | null;
  readonly peopleFailed?: boolean;
}

describe('AuditFilterSheet', () => {
  async function render(options: Setup = {}) {
    const fixture = TestBed.createComponent(AuditFilterSheet);
    fixture.componentRef.setInput('filter', options.filter ?? EMPTY_FILTER);
    fixture.componentRef.setInput(
      'sources',
      options.sources === undefined ? SOURCES : options.sources,
    );
    fixture.componentRef.setInput('people', options.people === undefined ? PEOPLE : options.people);
    fixture.componentRef.setInput('peopleFailed', options.peopleFailed ?? false);
    fixture.componentRef.setInput('selfId', 'eu');
    const applied: AuditFilter[] = [];
    const closed = vi.fn();
    const retry = vi.fn();
    fixture.componentInstance.applied.subscribe((filter) => applied.push(filter));
    fixture.componentInstance.closed.subscribe(closed);
    fixture.componentInstance.retryPeople.subscribe(retry);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const apply = () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    /** Os chips de um bloco (pelo nome do bloco), na ordem da tela. */
    const chips = (legend: string) =>
      Array.from(
        Array.from(el.querySelectorAll('fieldset'))
          .find((fieldset) => fieldset.querySelector('legend')?.textContent?.trim() === legend)
          ?.querySelectorAll('label.choice') ?? [],
      ).map((label) => label.textContent?.trim());
    const checked = () =>
      Array.from(el.querySelectorAll<HTMLInputElement>('input:checked')).map((input) =>
        input.closest('label')?.textContent?.trim(),
      );
    const click = (text: string) => {
      const label = Array.from(el.querySelectorAll<HTMLLabelElement>('label.choice')).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (!label) throw new Error(`Sem chip "${text}"`);
      label.querySelector('input')!.click();
      fixture.detectChanges();
    };
    return { fixture, el, applied, closed, retry, apply, chips, checked, click };
  }

  it('opens as a modal sheet focused on its title', async () => {
    const { el } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('audit-filter-title');
    expect(el.querySelector('#audit-filter-title')?.textContent?.trim()).toBe('Filtros');
  });

  it('never uses a native select: the CSP allows no inline style, and WebKit writes one into a select', async () => {
    const { el } = await render({
      filter: { ...EMPTY_FILTER, modules: ['tv'] },
    });
    expect(el.querySelector('select')).toBeNull();
    expect(el.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('offers the people (marking the viewer), the modules, the outcomes and the periods as chips', async () => {
    const { chips } = await render();
    expect(chips('Pessoa')).toEqual(['Todas as pessoas', 'Dono da Casa (você)', 'Bruno']);
    expect(chips('Módulo')).toEqual(['Aparelhos', 'Conta e acesso', 'TV']);
    expect(chips('Resultado')).toEqual(['Todos', 'Sucesso', 'Erro', 'Recusado']);
    expect(chips('Período')).toEqual([
      'Todo o período',
      'Últimas 24 horas',
      'Últimos 7 dias',
      'Últimos 30 dias',
    ]);
  });

  it('asks for a module before it lists the actions, which are many', async () => {
    const { el, chips } = await render();
    expect(chips('Ação')).toEqual([]);
    expect(el.textContent).toContain('Escolha um módulo para ver as ações dele.');
  });

  it('lists the actions of the chosen module in plain words, and leaves out a code it cannot name', async () => {
    const { click, chips, el } = await render();
    click('Conta e acesso');
    expect(chips('Ação')).toEqual(['Todas as ações', 'Entrou na conta', 'Tentou entrar']);
    expect(el.textContent).not.toContain('novo');
    // Um módulo só: sem o nome do módulo sobre as ações.
    expect(el.querySelector('.group-label')).toBeNull();
  });

  it('picks several modules at once and groups their actions under the name of each', async () => {
    const { click, chips, el } = await render();
    click('TV');
    click('Aparelhos');
    expect(chips('Ação')).toEqual([
      'Todas as ações',
      'Pareamento aprovado',
      'Aparelho revogado',
      'Tecla enviada à TV',
      'TV desligada',
    ]);
    expect(
      Array.from(el.querySelectorAll('.group-label')).map((g) => g.textContent?.trim()),
    ).toEqual(['Aparelhos', 'TV']);
  });

  it('keeps Aplicar disabled until something changed, then applies exactly what was chosen', async () => {
    const { apply, applied, click, closed } = await render();
    expect(apply().disabled).toBe(true);

    click('Bruno');
    click('Conta e acesso');
    click('Tentou entrar');
    click('Erro');
    click('Últimos 7 dias');
    expect(apply().disabled).toBe(false);
    apply().click();

    expect(applied).toEqual([
      {
        person: { id: 'g1', name: 'Bruno' },
        modules: ['identity'],
        action: 'login_failed',
        outcome: 'failure',
        period: '7d',
      },
    ]);
    expect(closed).not.toHaveBeenCalled();
  });

  it('drops the chosen action when its module is no longer in view', async () => {
    const { click, apply, applied } = await render();
    click('TV');
    click('Tecla enviada à TV');
    click('Conta e acesso');
    click('TV'); // tira o TV: sobra só a Conta e acesso, que não tem essa ação
    apply().click();
    expect(applied[0]).toMatchObject({ modules: ['identity'], action: null });
  });

  it('starts from the filter that is in force, and Limpar goes back to everything without applying', async () => {
    const start: AuditFilter = {
      person: { id: 'g1', name: 'Bruno' },
      modules: ['tv'],
      action: 'tv.key',
      outcome: 'denied',
      period: '30d',
    };
    const { el, checked, apply, applied, fixture } = await render({ filter: start });
    expect(checked()).toEqual(['Bruno', 'TV', 'Tecla enviada à TV', 'Recusado', 'Últimos 30 dias']);

    el.querySelector<HTMLButtonElement>('button.clear')!.click();
    fixture.detectChanges();
    expect(checked()).toEqual(['Todas as pessoas', 'Todos', 'Todo o período']);
    expect(apply().disabled).toBe(false);
    expect(applied).toEqual([]);

    apply().click();
    expect(applied).toEqual([EMPTY_FILTER]);
  });

  it('keeps an action that is in the filter visible even though no module chip is on', async () => {
    const { checked, chips } = await render({
      filter: { ...EMPTY_FILTER, action: 'tv.key' },
    });
    expect(chips('Ação')).toEqual(['Todas as ações', 'Tecla enviada à TV', 'TV desligada']);
    expect(checked()).toContain('Tecla enviada à TV');
  });

  it('keeps Limpar disabled when there is nothing to clear', async () => {
    const { el } = await render();
    expect(el.querySelector<HTMLButtonElement>('button.clear')!.disabled).toBe(true);
  });

  it('leaves without applying on Cancelar and on Esc', async () => {
    const first = await render();
    first.el.querySelector<HTMLButtonElement>('.buttons .secondary')!.click();
    expect(first.closed).toHaveBeenCalledTimes(1);
    expect(first.applied).toEqual([]);

    TestBed.resetTestingModule();
    const second = await render();
    const esc = new Event('cancel', { cancelable: true });
    second.el.querySelector('dialog')!.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(second.closed).toHaveBeenCalledTimes(1);
  });

  it('says the people are loading, and shows the person already chosen meanwhile', async () => {
    const { el, chips, checked } = await render({
      people: null,
      filter: { ...EMPTY_FILTER, person: { id: 'g1', name: 'Bruno' } },
    });
    expect(el.textContent).toContain('Carregando as pessoas');
    expect(chips('Pessoa')).toEqual(['Todas as pessoas', 'Bruno']);
    expect(checked()).toContain('Bruno');
  });

  it('says when the people could not be loaded and lets the administrator try again', async () => {
    const { el, retry } = await render({ people: null, peopleFailed: true });
    expect(el.textContent).toContain('Não deu para carregar as pessoas');
    el.querySelector<HTMLButtonElement>('.note .retry')!.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('still offers person, outcome and period when the sources never arrived, and no module or action', async () => {
    const { el } = await render({ sources: null });
    const legends = Array.from(el.querySelectorAll('legend')).map((l) => l.textContent?.trim());
    expect(legends).toEqual(['Pessoa', 'Resultado', 'Período']);
  });
});
