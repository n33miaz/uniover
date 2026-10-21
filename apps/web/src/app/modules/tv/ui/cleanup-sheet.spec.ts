import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { CleanupSheet } from './cleanup-sheet';

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

  it('opens as a modal sheet with the question and the warning about the app that is playing', () => {
    const dialog = root.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Limpar a TV?');
    expect(root.textContent).toContain(
      'Isso fecha todos os apps abertos, inclusive o que está passando agora, e libera memória. A conexão com o controle continua.',
    );
    expect(dialog.getAttribute('aria-labelledby')).toBe('cleanup-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('cleanup-text');
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
