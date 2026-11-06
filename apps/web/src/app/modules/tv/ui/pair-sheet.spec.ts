import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TvApi } from '../data/tv-api';
import { PairSheet } from './pair-sheet';

function problem(status: number, body: Record<string, unknown>): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: body });
}

describe('PairSheet', () => {
  let api: { pair: ReturnType<typeof vi.fn<(code?: string) => Promise<void>>> };
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
    api = { pair: vi.fn<(code?: string) => Promise<void>>().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({ providers: [{ provide: TvApi, useValue: api }] });
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

  it('Parear delivers the typed code, never keeps it, and finishes with Pronto', async () => {
    await showCode();
    await type('a1b2c3');
    named('Parear').click();
    await settle();

    expect(api.pair).toHaveBeenLastCalledWith('A1B2C3');
    expect(text()).toBe('TV pareada. O controle volta em instantes.');
    expect(label()).toEqual(['Pronto']);
    // O código não fica em lugar nenhum da folha depois de usado.
    expect(root.textContent).not.toContain('A1B2C3');
    expect(root.querySelector('input')).toBeNull();
    named('Pronto').click();
    expect(closed).toHaveBeenCalledTimes(1);
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
