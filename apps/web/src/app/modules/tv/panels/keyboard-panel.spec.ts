import { TestBed } from '@angular/core/testing';
import { TvFailure } from '../data/tv-errors';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { KeyboardPanel } from './keyboard-panel';

/** Cauda padrão do módulo (`TV_CONFIG.textTailMs`): o intervalo mínimo entre dois envios. */
const TAIL_MS = 100;

describe('KeyboardPanel', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<KeyboardPanel>>;
  let root: HTMLElement;
  let done: ReturnType<typeof vi.fn<() => void>>;

  const render = async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  const pause = async (ms = TAIL_MS) => {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
  };
  const input = () => root.querySelector<HTMLInputElement>('#tv-text')!;
  const type = async (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    await render();
  };
  const buttonByText = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('.actions button')].find(
      (el) => el.textContent?.trim() === text,
    )!;
  const status = () => root.querySelector('.status')?.textContent?.replace(/\s+/g, ' ').trim();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(KeyboardPanel);
    done = vi.fn<() => void>();
    fixture.componentInstance.done.subscribe(done);
    root = fixture.nativeElement;
    await render();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has the field first, labelled for the screen reader, focused when the panel opens', () => {
    const form = root.querySelector('form')!;
    expect(form.firstElementChild?.matches('label.sr-only')).toBe(true);
    expect(root.querySelector('label')?.textContent?.trim()).toBe('Texto para a TV');
    expect(form.children[1]).toBe(input());
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('placeholder')).toBe('Digite o texto para a TV');
  });

  it('has only one short hint, and none of the old warnings', () => {
    expect(root.querySelector('.hint')?.textContent?.trim()).toBe(
      'O texto aparece no campo aberto na TV enquanto você digita.',
    );
    expect(root.querySelector('.warn, .note')).toBeNull();
    expect(root.textContent).not.toContain('Pode funcionar só em caixas de busca');
    expect(root.textContent).not.toContain('Para apagar tudo');
    expect(root.textContent).not.toContain('Texto vazio não é enviado');
  });

  it('says why typing will not reach the TV before anyone types, and only then', async () => {
    expect(root.querySelector('.blocked')).toBeNull();
    store.canSend.set(false);
    store.disabledReason.set('O agente da TV está desligado, então os botões não funcionam agora.');
    await render();
    expect(root.querySelector('.blocked')?.textContent?.trim()).toBe(
      'O agente da TV está desligado, então os botões não funcionam agora.',
    );
    expect(root.querySelector('.blocked')?.getAttribute('role')).toBe('status');
    store.canSend.set(true);
    store.disabledReason.set(null);
    await render();
    expect(root.querySelector('.blocked')).toBeNull();
  });

  it('has no Enviar and no OK button: only Limpar and Fechar', () => {
    const labels = [...root.querySelectorAll('button')].map((el) => el.textContent?.trim());
    expect(labels).toEqual(['Limpar', 'Fechar']);
    expect(root.querySelector('button[type="submit"]')).toBeNull();
  });

  it('starts empty with Limpar disabled, no counter and nothing sent', () => {
    expect(input().value).toBe('');
    expect(root.querySelector('.count')).toBeNull();
    expect(buttonByText('Limpar').disabled).toBe(true);
    expect(store.sendText).not.toHaveBeenCalled();
  });

  it('sends the first letter at once, then the whole text after the tail, and keeps the field', async () => {
    await type('b');
    // Primeira mudança: vai na hora, sem pausa e sem apertar nada.
    expect(store.sendText).toHaveBeenCalledTimes(1);
    expect(store.sendText).toHaveBeenLastCalledWith('b');
    await type('ba');
    await type('bat');
    await type('batman');
    expect(store.sendText).toHaveBeenCalledTimes(1);
    await pause();
    expect(store.sendText).toHaveBeenCalledTimes(2);
    expect(store.sendText).toHaveBeenLastCalledWith('batman');
    await render();
    expect(input().value).toBe('batman');
    expect(status()).toBe('Texto na TV.');
    expect(root.querySelector('.count')).toBeNull();
  });

  it('shows the counter only when the limit is near (from 160 characters)', async () => {
    await type('a'.repeat(159));
    expect(root.querySelector('.count')).toBeNull();
    await type('a'.repeat(160));
    expect(root.querySelector('.count')?.textContent?.trim()).toBe('160 / 200');
    expect(root.querySelector('.count')?.classList.contains('over')).toBe(false);
  });

  it('shows "Enviando…" while the request is in flight', async () => {
    let finish: (failure: TvFailure | null) => void = () => undefined;
    store.sendText.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await type('bat');
    expect(status()).toBe('Enviando para a TV…');
    finish(null);
    await render();
    expect(status()).toBe('Texto na TV.');
  });

  it('sends the new text each time it changes after a pause (the field mirrors the TV)', async () => {
    await type('bat');
    await pause();
    await type('batman');
    await pause();
    expect(store.sendText.mock.calls.map((call) => call[0])).toEqual(['bat', 'batman']);
  });

  it('keeps the text and shows a quiet error, then tries again on the next change', async () => {
    store.sendText.mockResolvedValueOnce({
      kind: 'timeout',
      message: 'A TV não respondeu a tempo. Tente de novo.',
      retryAfterSeconds: null,
    });
    await type('bat');
    await pause();
    await render();
    expect(input().value).toBe('bat');
    expect(status()).toContain('A TV não respondeu a tempo.');
    expect(status()).toContain('Continue digitando para tentar de novo.');
    expect(root.querySelector('[role="alert"]')).toBeNull();

    await type('batm');
    await pause();
    await render();
    expect(store.sendText).toHaveBeenLastCalledWith('batm');
    expect(status()).toBe('Texto na TV.');
  });

  it('erasing down to empty sends the empty text, so the TV field empties too', async () => {
    await type('bat');
    await pause();
    await type('ba');
    await pause();
    await type('');
    await pause();
    expect(store.sendText.mock.calls.map((call) => call[0])).toEqual(['bat', 'ba', '']);
    await render();
    expect(status()).toBe('Campo da TV limpo.');
  });

  it('opening and closing the panel without typing sends nothing', () => {
    fixture.destroy();
    expect(store.sendText).not.toHaveBeenCalled();
  });

  it('refuses more than 200 characters, counting characters and not UTF-16 units', async () => {
    await type('a'.repeat(201));
    await pause(2000);
    expect(store.sendText).not.toHaveBeenCalled();
    expect(root.querySelector('.count')?.classList.contains('over')).toBe(true);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(root.textContent).toContain('A TV recebe no máximo 200 caracteres');

    await type('😀'.repeat(200));
    expect(root.querySelector('.count')?.textContent?.trim()).toBe('200 / 200');
    expect(input().getAttribute('aria-invalid')).toBeNull();
    expect(store.sendText).toHaveBeenCalledTimes(1);
  });

  it('Enter sends right away, without waiting for the tail', async () => {
    await type('b');
    await type('bat');
    expect(store.sendText).toHaveBeenCalledTimes(1);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(store.sendText).toHaveBeenLastCalledWith('bat');
  });

  it('Limpar empties the phone field and the TV field too, at once', async () => {
    await type('bat');
    await pause();
    expect(store.sendText).toHaveBeenCalledTimes(1);
    buttonByText('Limpar').click();
    await render();
    expect(input().value).toBe('');
    expect(store.sendText.mock.calls.map((call) => call[0])).toEqual(['bat', '']);
    await render();
    expect(status()).toBe('Campo da TV limpo.');
    await pause(2000);
    expect(store.sendText).toHaveBeenCalledTimes(2);
    expect(buttonByText('Limpar').disabled).toBe(true);
  });

  it('Limpar while the text is still going out sends the empty text right after it', async () => {
    let finish: (failure: TvFailure | null) => void = () => undefined;
    store.sendText.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await type('bat');
    buttonByText('Limpar').click();
    await render();
    expect(store.sendText).toHaveBeenCalledTimes(1);
    finish(null);
    await render();
    expect(store.sendText.mock.calls.map((call) => call[0])).toEqual(['bat', '']);
  });

  it('Fechar asks the panel to close, and what was still pending is sent when it goes away', async () => {
    await type('b');
    await type('bat');
    expect(store.sendText).toHaveBeenCalledTimes(1);
    buttonByText('Fechar').click();
    expect(done).toHaveBeenCalledTimes(1);
    fixture.destroy();
    expect(store.sendText).toHaveBeenLastCalledWith('bat');
  });

  it('turns off autocorrect and capitalization for a field that goes to a TV', () => {
    expect(input().getAttribute('autocapitalize')).toBe('off');
    expect(input().getAttribute('autocorrect')).toBe('off');
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().getAttribute('spellcheck')).toBe('false');
    // `maxlength` contaria unidades UTF-16 e travaria emoji no meio do limite de 200 caracteres.
    expect(input().hasAttribute('maxlength')).toBe(false);
  });
});
