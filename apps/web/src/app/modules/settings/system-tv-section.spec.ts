import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, TvComputer, TvConfig, TvItem } from './system-api';
import { SystemTvSection } from './system-tv-section';
import { TvEditSheet } from './tv-edit-sheet';

const CASA_PC: TvComputer = {
  slug: 'pc-casa',
  name: 'PC de casa',
  platform: 'windows',
  online: true,
};
const AMIGO_PC: TvComputer = {
  slug: 'pc-amigo',
  name: 'PC do Raphael',
  platform: 'windows',
  online: false,
};
const LIVRE_PC: TvComputer = {
  slug: 'pc-livre',
  name: 'Notebook',
  platform: 'linux',
  online: true,
};

const CASA: TvItem = {
  id: 'tv-casa',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.adb'],
  allowBackgroundAppClosing: false,
};
const AMIGO: TvItem = {
  id: 'tv-amigo',
  name: 'Raphael',
  isDefault: false,
  agentSlug: 'pc-amigo',
  kind: 'samsung',
  online: false,
  capabilities: ['tv.remote', 'tv.kind.samsung'],
  allowBackgroundAppClosing: false,
};

function config(agents: TvComputer[]): TvConfig {
  return {
    name: 'TV',
    agentSlug: 'pc-casa',
    agentName: 'PC de casa',
    source: 'saved',
    agentStatus: 'online',
    agents,
  };
}

/** A folha de verdade é testada à parte: aqui ela só mostra com o que a tela a abriu e deixa o teste fechá-la. */
@Component({
  selector: 'app-tv-edit-sheet',
  template: '<p class="fake-sheet">{{ tv()?.name ?? "nova" }}</p>',
})
class FakeSheet {
  readonly tv = input<TvItem | null>(null);
  readonly computers = input.required<readonly TvComputer[]>();
  readonly closed = output<boolean>();
}

describe('SystemTvSection', () => {
  const api = { tvs: vi.fn(), tvConfig: vi.fn() };

  beforeEach(() => {
    api.tvs.mockReset().mockResolvedValue([CASA, AMIGO]);
    api.tvConfig.mockReset().mockResolvedValue(config([CASA_PC, AMIGO_PC, LIVRE_PC]));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SystemApi, useValue: api }],
    });
    TestBed.overrideComponent(SystemTvSection, {
      remove: { imports: [TvEditSheet] },
      add: { imports: [FakeSheet] },
    });
  });

  function signIn(role: 'owner' | 'guest' | null = 'owner') {
    const session = TestBed.inject(SessionState);
    if (role) {
      session.setToken('t', 600);
      session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role });
    }
  }

  async function render() {
    const fixture = TestBed.createComponent(SystemTvSection);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const rows = () => Array.from(el.querySelectorAll<HTMLButtonElement>('ul.tvs button.ui-row'));
    const add = () => el.querySelector<HTMLButtonElement>('button.add');
    const sheet = () =>
      fixture.debugElement.children.find((child) => child.name === 'app-tv-edit-sheet');
    const closeSheet = async (changed: boolean) => {
      sheet()!.componentInstance.closed.emit(changed);
      await settle();
    };
    return { fixture, el, rows, add, sheet, closeSheet, settle };
  }

  it('loads for the administrator and lists every TV with its computer, its type and whether it is on', async () => {
    signIn();
    const { el, rows } = await render();
    expect(api.tvs).toHaveBeenCalledTimes(1);
    expect(api.tvConfig).toHaveBeenCalledTimes(1);
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('TVs');
    expect(rows().map((row) => row.querySelector('.ui-row-title')?.textContent?.trim())).toEqual([
      'Sala',
      'Raphael',
    ]);
    expect(rows().map((row) => row.querySelector('.ui-row-sub')?.textContent?.trim())).toEqual([
      'PC de casa · Android',
      'PC do Raphael · Samsung',
    ]);
    expect(rows().map((row) => row.querySelector('.chip')?.textContent?.trim())).toEqual([
      'Ligado',
      'Desligado',
    ]);
  });

  it('never calls the API for a guest, nor without a session', async () => {
    signIn('guest');
    await render();
    expect(api.tvs).not.toHaveBeenCalled();
    expect(api.tvConfig).not.toHaveBeenCalled();
  });

  it('says that a TV whose computer is no longer paired cannot be found, and that one without a computer has none', async () => {
    signIn();
    api.tvs.mockResolvedValue([
      { ...CASA, agentSlug: 'pc-revogado', kind: null },
      { ...AMIGO, agentSlug: null, kind: null },
    ]);
    const { rows } = await render();
    expect(rows().map((row) => row.querySelector('.ui-row-sub')?.textContent?.trim())).toEqual([
      'Computador não encontrado',
      'Nenhum computador escolhido',
    ]);
    expect(rows()[0].querySelector('.chip')?.textContent?.trim()).toBe('Não encontrado');
  });

  it('offers to add a TV when a paired computer is still free, and opens the sheet to create one', async () => {
    signIn();
    const { add, sheet, settle } = await render();
    expect(add()).not.toBeNull();
    expect(add()!.getAttribute('aria-haspopup')).toBe('dialog');
    add()!.click();
    await settle();
    const open = sheet()!;
    expect(open.componentInstance.tv()).toBeNull();
    // Só o computador livre pode ganhar a TV nova.
    expect(open.componentInstance.computers().map((c: TvComputer) => c.slug)).toEqual(['pc-livre']);
  });

  it('opens the sheet of the TV that was touched, offering its own computer besides the free ones', async () => {
    signIn();
    const { rows, sheet, settle } = await render();
    rows()[1].click();
    await settle();
    expect(sheet()!.componentInstance.tv()).toEqual(AMIGO);
    expect(
      sheet()!
        .componentInstance.computers()
        .map((c: TvComputer) => c.slug),
    ).toEqual(['pc-amigo', 'pc-livre']);
  });

  it('has no add button when every paired computer already has a TV: it explains and leads to Dispositivos', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(config([CASA_PC, AMIGO_PC]));
    const { el, add } = await render();
    expect(add()).toBeNull();
    expect(el.textContent).toContain('Todo computador pareado já tem uma TV');
    expect(el.querySelector('a.devices-link')?.getAttribute('href')).toBe('/ajustes/dispositivos');
  });

  it('re-reads the list and confirms when the sheet saved something, and gives the focus back to the button', async () => {
    signIn();
    const { el, rows, closeSheet, settle } = await render();
    rows()[0].click();
    await settle();
    api.tvs.mockResolvedValue([CASA, { ...AMIGO, name: 'Quarto' }]);
    await closeSheet(true);
    expect(api.tvs).toHaveBeenCalledTimes(2);
    expect(rows().map((row) => row.querySelector('.ui-row-title')?.textContent?.trim())).toEqual([
      'Sala',
      'Quarto',
    ]);
    expect(el.querySelector('.message')?.textContent).toContain('Pronto');
    expect(el.querySelector('app-tv-edit-sheet')).toBeNull();
    expect(document.activeElement === rows()[0] || !rows()[0].isConnected).toBe(true);
  });

  it('does not read anything again when the sheet closed with nothing changed', async () => {
    signIn();
    const { el, rows, closeSheet, settle } = await render();
    rows()[0].click();
    await settle();
    await closeSheet(false);
    expect(api.tvs).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.message')).toBeNull();
  });

  it('says when there is no TV yet', async () => {
    signIn();
    api.tvs.mockResolvedValue([]);
    const { el } = await render();
    expect(el.textContent).toContain('Nenhuma TV ainda.');
    expect(el.querySelector('ul.tvs')).toBeNull();
  });

  it('shows the error and lets the administrator try again', async () => {
    signIn();
    api.tvs.mockRejectedValueOnce(new Error('falhou'));
    const { el, rows, settle } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível carregar as TVs',
    );
    el.querySelector<HTMLButtonElement>('button.retry')!.click();
    await settle();
    expect(rows()).toHaveLength(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('holds the shape of the TV list as a busy skeleton until the TVs arrive', async () => {
    let finish: (tvs: TvItem[]) => void = () => undefined;
    api.tvs.mockReturnValue(new Promise<TvItem[]>((resolve) => (finish = resolve)));
    signIn();
    const { el, rows, settle } = await render();

    expect(
      el.querySelector('app-loading-skeleton app-loading-frame[aria-busy="true"]'),
    ).not.toBeNull();
    expect(rows()).toHaveLength(0);

    finish([CASA]);
    await settle();
    expect(el.querySelector('app-loading-skeleton')).toBeNull();
    expect(rows()).toHaveLength(1);
  });
});
