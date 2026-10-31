import { TestBed } from '@angular/core/testing';
import { TvPermissionSheet } from './tv-permission-sheet';
import { PermissionAsk, TvPermissionService } from './tv-permission.service';

describe('TvPermissionSheet', () => {
  const service = { ask: vi.fn(), waitForGrant: vi.fn(), stillPending: vi.fn() };

  beforeEach(() => {
    service.ask.mockReset().mockResolvedValue('asked' satisfies PermissionAsk);
    service.waitForGrant.mockReset().mockResolvedValue(true);
    service.stillPending.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [{ provide: TvPermissionService, useValue: service }],
    });
  });

  async function render(options: { showName?: boolean } = {}) {
    const fixture = TestBed.createComponent(TvPermissionSheet);
    fixture.componentRef.setInput('tvId', 'tv-2');
    fixture.componentRef.setInput('tvName', 'Raphael');
    fixture.componentRef.setInput('showName', options.showName ?? false);
    const later: number[] = [];
    const closed: boolean[] = [];
    fixture.componentInstance.later.subscribe(() => later.push(1));
    fixture.componentInstance.closed.subscribe((granted) => closed.push(granted));
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    fixture.detectChanges();
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent?.trim() === text,
      )!;
    return { fixture, el, button, settle, later, closed };
  }

  it('opens as a modal sheet with one short sentence and two buttons', async () => {
    const { el, button } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Permissão da TV');
    expect(el.querySelector('#tv-permission-text')?.textContent?.trim()).toBe(
      'Na próxima vez que a TV mostrar um pedido do UniOver, escolha Permitir. É uma vez só.',
    );
    expect(button('Pedir Agora')).toBeDefined();
    expect(button('Depois')).toBeDefined();
    expect(dialog.getAttribute('aria-labelledby')).toBe('tv-permission-title');
    expect(service.ask).not.toHaveBeenCalled();
  });

  it('shows the TV name only when there are several in the queue', async () => {
    expect((await render()).el.querySelector('.tv-name')).toBeNull();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: TvPermissionService, useValue: service }],
    });
    const { el } = await render({ showName: true });
    expect(el.querySelector('.tv-name')?.textContent?.trim()).toBe('Raphael');
  });

  it('Pedir Agora asks once, waits for the accept and ends with Pronto', async () => {
    const { el, button, settle, closed } = await render();
    button('Pedir Agora').click();
    await settle();
    expect(service.ask).toHaveBeenCalledOnce();
    expect(service.ask).toHaveBeenCalledWith('tv-2');
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Pronto');
    button('Fechar').click();
    await settle();
    expect(closed).toEqual([true]);
  });

  it('shows Olhe a TV while the accept is pending and cannot ask twice', async () => {
    let finish!: (granted: boolean) => void;
    service.waitForGrant.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
    const { el, button, settle } = await render();
    button('Pedir Agora').click();
    await settle();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Olhe a TV');
    expect(button('Pedir Agora').disabled).toBe(true);
    button('Pedir Agora').click();
    await settle();
    expect(service.ask).toHaveBeenCalledOnce();
    finish(true);
    await settle();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Pronto');
  });

  it('keeps waiting when the notice is already on the TV screen', async () => {
    service.ask.mockResolvedValue('busy');
    const { el, button, settle } = await render();
    button('Pedir Agora').click();
    await settle();
    expect(service.waitForGrant).toHaveBeenCalledOnce();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Pronto');
  });

  it('uses the reader it was given to follow the accept', async () => {
    const reader = vi.fn().mockResolvedValue(false);
    const { fixture, button, settle } = await render();
    fixture.componentRef.setInput('stillNeeded', reader);
    fixture.detectChanges();
    button('Pedir Agora').click();
    await settle();
    const given = service.waitForGrant.mock.calls[0][0] as () => Promise<boolean>;
    await given();
    expect(reader).toHaveBeenCalledOnce();
    expect(service.stillPending).not.toHaveBeenCalled();
  });

  it.each([
    ['unreachable', 'A TV Não Respondeu', 'Ligue a TV e tente de novo.', 'Tentar de Novo'],
    [
      'unsupported',
      'Computador Desatualizado',
      'Atualize o computador da TV para pedir a permissão.',
      null,
    ],
    [
      'failed',
      'Não Deu Certo',
      'Não foi possível pedir agora. Tente de novo em instantes.',
      'Tentar de Novo',
    ],
  ] satisfies [PermissionAsk, string, string, string | null][])(
    'explains %s and does not wait for an accept',
    async (outcome, title, text, retry) => {
      service.ask.mockResolvedValue(outcome);
      const { el, button, settle } = await render();
      button('Pedir Agora').click();
      await settle();
      expect(el.querySelector('h2')?.textContent?.trim()).toBe(title);
      expect(el.querySelector('#tv-permission-text')?.textContent?.trim()).toBe(text);
      expect(service.waitForGrant).not.toHaveBeenCalled();
      if (retry) expect(button(retry)).toBeDefined();
    },
  );

  it('offers another try when nobody accepts in time, and the second ask reaches the API', async () => {
    service.waitForGrant.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { el, button, settle } = await render();
    button('Pedir Agora').click();
    await settle();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Sem Resposta');
    button('Tentar de Novo').click();
    await settle();
    expect(service.ask).toHaveBeenCalledTimes(2);
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Pronto');
  });

  it('Depois tells the host to hide the TV for this visit', async () => {
    const { button, settle, later, closed } = await render();
    button('Depois').click();
    await settle();
    expect(later).toEqual([1]);
    expect(closed).toEqual([false]);
  });

  it('Esc counts as Depois', async () => {
    const { el, settle, later, closed } = await render();
    el.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await settle();
    expect(later).toEqual([1]);
    expect(closed).toEqual([false]);
  });
});
