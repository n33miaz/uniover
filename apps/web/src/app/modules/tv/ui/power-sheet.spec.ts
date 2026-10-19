import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { PowerSheet } from './power-sheet';

describe('PowerSheet', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PowerSheet>>;
  let root: HTMLElement;
  let closed: ReturnType<typeof vi.fn<() => void>>;

  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const named = (name: string) => buttons().find((b) => b.textContent?.trim() === name)!;

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(PowerSheet);
    closed = vi.fn<() => void>();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  });

  it('opens as a modal sheet with the question and the warning', () => {
    const dialog = root.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Desligar a TV?');
    expect(root.textContent).toContain(
      'Sem o emissor infravermelho, a TV só volta com o controle original.',
    );
    expect(dialog.getAttribute('aria-labelledby')).toBe('power-title');
  });

  it('has only Cancelar and Desligar (no close button)', () => {
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Cancelar', 'Desligar']);
  });

  it('Cancelar closes without sending anything', () => {
    named('Cancelar').click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.powerOff).not.toHaveBeenCalled();
  });

  it('Esc cancels the same way, and stops the browser from closing it twice', () => {
    const event = new Event('cancel', { cancelable: true });
    root.querySelector('dialog')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.powerOff).not.toHaveBeenCalled();
  });

  it('Desligar asks once and closes when it worked', async () => {
    named('Desligar').click();
    await fixture.whenStable();
    expect(store.powerOff).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('keeps the sheet open and shows the reason inside it when the TV does not answer', async () => {
    store.powerOff.mockResolvedValueOnce({
      kind: 'timeout',
      message: 'A TV não respondeu a tempo. Tente de novo.',
      retryAfterSeconds: null,
    });
    named('Desligar').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(closed).not.toHaveBeenCalled();
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('A TV não respondeu a tempo. Tente de novo.');
    expect(named('Desligar').disabled).toBe(false);
  });

  it('blocks both buttons while the request is going', async () => {
    let release!: () => void;
    store.powerOff.mockReturnValueOnce(new Promise((resolve) => (release = () => resolve(null))));
    named('Desligar').click();
    fixture.detectChanges();
    expect(named('Desligar').disabled).toBe(true);
    expect(named('Cancelar').disabled).toBe(true);
    named('Desligar').click();
    expect(store.powerOff).toHaveBeenCalledTimes(1);
    release();
    await fixture.whenStable();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('cannot confirm while the remote cannot send', () => {
    store.canSend.set(false);
    fixture.detectChanges();
    expect(named('Desligar').disabled).toBe(true);
  });
});
