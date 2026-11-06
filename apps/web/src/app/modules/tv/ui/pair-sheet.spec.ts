import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TvApi } from '../data/tv-api';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { PAIR_CONFIRM_MS, PairSheet } from './pair-sheet';

function problem(status: number, body: Record<string, unknown>): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: body });
}

describe('PairSheet', () => {
  let api: {
    pair: ReturnType<typeof vi.fn<(code?: string) => Promise<void>>>;
    cancelPair: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PairSheet>>;
  let root: HTMLElement;
  let closed: ReturnType<typeof vi.fn<() => void>>;

  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const named = (name: string) => buttons().find((b) => b.textContent?.trim() === name)!;
  const label = () => buttons().map((b) => b.textContent?.trim());
  const text = () => root.querySelector('#pair-text')?.textContent?.replace(/\s+/g, ' ').trim();
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const input = () => root.querySelector<HTMLInputElement>('input.code')!;
  const type = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    await settle();
  };
  /** O caminho de quem usa: toca em "Mostrar Código" e espera o campo do código. */
  const showCode = async () => {
    named('Mostrar Código').click();
    await settle();
  };

  beforeEach(async () => {
    api = {
      pair: vi.fn<(code?: string) => Promise<void>>().mockResolvedValue(undefined),
      cancelPair: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    store = createFakeTvStore();
    store.status.set('not-paired');
    TestBed.configureTestingModule({
      providers: [
        { provide: TvApi, useValue: api },
        { provide: TvStore, useValue: store },
      ],
    });
    fixture = TestBed.createComponent(PairSheet);
    closed = vi.fn<() => void>();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  });

  it('opens as a modal sheet that explains the step and asks nothing from the TV by itself', () => {
    const dialog = root.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Parear a TV');
    expect(text()).toBe('A TV mostra um código de 6 caracteres na tela. Deixe-a ligada.');
    expect(label()).toEqual(['Cancelar', 'Mostrar Código']);
    expect(api.pair).not.toHaveBeenCalled();
  });

  it('Cancelar closes without asking for anything', () => {
    named('Cancelar').click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(api.pair).not.toHaveBeenCalled();
  });

  it('Mostrar Código asks the TV for the code (no code in the request) and shows the field', async () => {
    await showCode();
    expect(api.pair).toHaveBeenCalledTimes(1);
    expect(api.pair).toHaveBeenCalledWith();
    expect(text()).toBe('Digite o código que aparece na TV.');
    expect(label()).toEqual(['Cancelar', 'Parear']);
    expect(named('Parear').disabled).toBe(true);
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().getAttribute('maxlength')).toBe('6');
  });

  it('cleans what is typed to the code format and enables Parear only with 6 characters', async () => {
    await showCode();
    await type('a1 b2-c');
    expect(input().value).toBe('A1B2C');
    expect(named('Parear').disabled).toBe(true);
    await type('a1b2c3d4');
    expect(input().value).toBe('A1B2C3');
    expect(named('Parear').disabled).toBe(false);
  });

  it('Parear delivers the typed code, never keeps it, and finishes with Pronto once the state moves on', async () => {
    await showCode();
    await type('a1b2c3');
    named('Parear').click();
    await settle();

    expect(api.pair).toHaveBeenLastCalledWith('A1B2C3');
    // A TV aceitou o código, mas só vale "pareada" quando o estado deixa de ser "não pareada".
    expect(text()).toBe('Pareando…');
    store.status.set('hot');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(text()).toBe('TV pareada. O controle volta em instantes.');
    });
    expect(label()).toEqual(['Pronto']);
    // O código não fica em lugar nenhum da folha depois de usado.
    expect(root.textContent).not.toContain('A1B2C3');
    expect(root.querySelector('input')).toBeNull();
    named('Pronto').click();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('says the TV did not accept the pairing when the state stays not paired', async () => {
    vi.useFakeTimers();
    try {
      await showCode();
      await type('a1b2c3');
      named('Parear').click();
      await vi.advanceTimersByTimeAsync(PAIR_CONFIRM_MS + 1000);
      fixture.detectChanges();
      expect(text()).toBe('A TV não aceitou o pareamento. Tente de novo com um código novo.');
      expect(label()).toEqual(['Fechar', 'Tentar de Novo']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a TV that is off after pairing as paired (the state is no longer not paired)', async () => {
    await showCode();
    await type('a1b2c3');
    store.status.set('agent-off');
    named('Parear').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(text()).toBe('TV pareada. O controle volta em instantes.');
    });
  });

  it('closing with the code on the TV screen tells the computer to drop the pairing', async () => {
    await showCode();
    named('Cancelar').click();
    expect(api.cancelPair).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closing while the code is being asked also cancels, and a failed cancel is silent', async () => {
    api.cancelPair.mockRejectedValue(new Error('sem rede'));
    let release: () => void = () => undefined;
    api.pair.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    named('Mostrar Código').click();
    await settle();
    root.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(api.cancelPair).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    release();
    await settle();
  });

  it('does not cancel when there is nothing waiting for the code', async () => {
    named('Cancelar').click(); // introdução: nada foi pedido
    expect(api.cancelPair).not.toHaveBeenCalled();
  });

  it('does not cancel after a refused code (the computer already dropped it)', async () => {
    await showCode();
    await type('a1b2c3');
    api.pair.mockRejectedValueOnce(problem(502, { agentError: 'invalid_code' }));
    named('Parear').click();
    await settle();
    named('Fechar').click();
    expect(api.cancelPair).not.toHaveBeenCalled();
  });

  it('asks to wait when the API says the code was asked for too soon', async () => {
    api.pair.mockRejectedValueOnce(
      problem(429, { type: 'https://uniover.dev/problems/pair-too-soon' }),
    );
    await showCode();
    expect(text()).toBe('Espere alguns segundos antes de pedir outro código.');
    expect(label()).toEqual(['Fechar', 'Tentar de Novo']);
  });

  it('a refused code asks for a new one and starts over only by another tap', async () => {
    await showCode();
    await type('a1b2c3');
    api.pair.mockRejectedValueOnce(problem(502, { agentError: 'invalid_code' }));
    named('Parear').click();
    await settle();

    expect(text()).toBe('O código não serviu ou venceu. Peça outro à TV.');
    expect(label()).toEqual(['Fechar', 'Tentar de Novo']);
    expect(root.textContent).not.toContain('A1B2C3');
    expect(api.pair).toHaveBeenCalledTimes(2);

    named('Tentar de Novo').click();
    await settle();
    expect(api.pair).toHaveBeenCalledTimes(3);
    expect(api.pair).toHaveBeenLastCalledWith();
    expect(input().value).toBe('');
  });

  it('says the TV did not answer when the agent or the TV is out, and offers another try', async () => {
    api.pair.mockRejectedValueOnce(problem(502, { agentError: 'tv_unreachable' }));
    await showCode();
    expect(text()).toBe('A TV não respondeu. Ligue-a e tente de novo.');
    expect(label()).toEqual(['Fechar', 'Tentar de Novo']);
  });

  it('explains an old computer without offering a retry that cannot work', async () => {
    api.pair.mockRejectedValueOnce(
      problem(409, { type: 'https://uniover.dev/problems/pair-unsupported' }),
    );
    await showCode();
    expect(text()).toBe('O computador da TV precisa ser atualizado para parear pelo app.');
    expect(label()).toEqual(['Fechar']);
  });

  it('tells a non-owner that only the administrator pairs', async () => {
    api.pair.mockRejectedValueOnce(
      problem(403, { type: 'https://uniover.dev/problems/forbidden' }),
    );
    await showCode();
    expect(text()).toBe('Só quem administra o app pode parear a TV.');
    expect(label()).toEqual(['Fechar']);
  });

  it('any other failure is told plainly, with another try', async () => {
    api.pair.mockRejectedValueOnce(problem(500, {}));
    await showCode();
    expect(text()).toBe('Não consegui parear agora. Tente de novo.');
    expect(label()).toEqual(['Fechar', 'Tentar de Novo']);
  });

  it('a second tap while the request is out does not send it twice', async () => {
    let release: () => void = () => undefined;
    api.pair.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    named('Mostrar Código').click();
    await settle();
    expect(root.querySelector('dialog')?.getAttribute('aria-busy')).toBe('true');
    release();
    await settle();
    expect(api.pair).toHaveBeenCalledTimes(1);
  });

  it('Esc closes like Cancelar', () => {
    const cancel = new Event('cancel', { cancelable: true });
    root.querySelector('dialog')!.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
