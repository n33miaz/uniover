import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeTv } from '../tv-test-kit';
import { CleanupSheet } from './cleanup-sheet';

function clickBackdrop(dialog: HTMLDialogElement): void {
  Object.defineProperty(dialog, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 10, top: 10, right: 300, bottom: 500 }),
  });
  dialog.dispatchEvent(
    Object.assign(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0 }), {
      isPrimary: true,
    }),
  );
  dialog.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
}

describe('CleanupSheet', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<CleanupSheet>>;
  let root: HTMLElement;
  let closed: ReturnType<typeof vi.fn<() => void>>;

  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const named = (name: string) => buttons().find((b) => b.textContent?.trim() === name)!;

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(CleanupSheet);
    closed = vi.fn<() => void>();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  });

  it('opens as a modal sheet with the question and says only memory is freed while the TV switch is off', () => {
    const dialog = root.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Limpar a TV?');
    expect(root.textContent).toContain(
      'Libera memória sem fechar nenhum app. A conexão com o controle continua.',
    );
    expect(root.textContent).not.toContain('fecha todos');
    expect(dialog.getAttribute('aria-labelledby')).toBe('cleanup-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('cleanup-text');
  });

  it('says background apps are closed, never the one in front, when the TV switch is on', async () => {
    store.tvs.set([makeTv('sala', { allowBackgroundAppClosing: true })]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(root.querySelector('#cleanup-text')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Fecha os apps em segundo plano e libera memória. O app que está passando agora continua aberto, e a conexão com o controle também.',
    );
    expect(root.textContent).not.toContain('fecha todos');
  });

  it('has only Cancelar and Limpar (no close button)', () => {
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Cancelar', 'Limpar']);
  });

  it('Cancelar closes without asking for anything', () => {
    named('Cancelar').click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it('Esc cancels the same way, and stops the browser from closing it twice', () => {
    const event = new Event('cancel', { cancelable: true });
    root.querySelector('dialog')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it('a touch that begins and ends on the backdrop cancels the same way', () => {
    clickBackdrop(root.querySelector('dialog')!);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it('closes the dialog before notifying the page and returns focus to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const second = TestBed.createComponent(CleanupSheet);
    second.detectChanges();
    await second.whenStable();
    const dialog = (second.nativeElement as HTMLElement).querySelector('dialog')!;
    const secondClosed = vi.fn<() => void>();
    second.componentInstance.closed.subscribe(() => {
      expect(dialog.open).toBe(false);
      secondClosed();
    });

    clickBackdrop(dialog);

    expect(secondClosed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('Limpar starts the cleanup once and closes right away: the progress lives outside the sheet', () => {
    named('Limpar').click();
    expect(store.cleanup).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('does not start a second cleanup on a second tap while it leaves', () => {
    named('Limpar').click();
    named('Limpar').click();
    expect(store.cleanup).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('does not ask while a cleanup is already running', () => {
    store.cleaning.set(true);
    named('Limpar').click();
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it('keeps Limpar off without an agent, and Cancelar always works', async () => {
    store.canSend.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(named('Limpar').disabled).toBe(true);
    named('Limpar').click();
    expect(store.cleanup).not.toHaveBeenCalled();
    named('Cancelar').click();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
