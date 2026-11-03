import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FAILURE, FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PowerPage } from './power.page';

describe('PowerPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PowerPage>>;
  let root: HTMLElement;

  const action = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('.action')].find(
      (b) => b.textContent?.trim() === name,
    )!;
  const sheet = () => root.querySelector<HTMLDialogElement>('dialog');
  const sheetButton = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === name,
    )!;

  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PowerPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('locks right away, with no confirmation', async () => {
    action('Bloquear').click();
    await settle();
    expect(store.power).toHaveBeenCalledExactlyOnceWith('LOCK', false);
    expect(sheet()).toBeNull();
  });

  it.each([
    ['Suspender', 'SLEEP', 'Suspender o PC?'],
    ['Desligar', 'SHUTDOWN', 'Desligar o PC?'],
  ])('%s asks first and only sends after the confirmation', async (label, code, title) => {
    action(label).click();
    await settle();
    expect(store.power).not.toHaveBeenCalled();
    expect(sheet()?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe(title);

    sheetButton(label).click();
    await settle();
    expect(store.power).toHaveBeenCalledExactlyOnceWith(code, true);
    expect(sheet()).toBeNull();
  });

  it('cancelling the sheet sends nothing', async () => {
    action('Desligar').click();
    await settle();
    sheetButton('Cancelar').click();
    await settle();
    expect(store.power).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it('keeps the sheet open and says why when the request failed', async () => {
    store.power.mockResolvedValueOnce(FAILURE);
    action('Suspender').click();
    await settle();
    sheetButton('Suspender').click();
    await settle();
    expect(sheet()).not.toBeNull();
    expect(root.querySelector('dialog .error')?.textContent).toContain('O PC está desconectado.');
  });

  it('after asking to shut down, offers to cancel the countdown, and cancelling hides it', async () => {
    expect(root.querySelector('.cancel')).toBeNull();
    action('Desligar').click();
    await settle();
    sheetButton('Desligar').click();
    await settle();
    const cancel = root.querySelector<HTMLButtonElement>('.cancel button')!;
    expect(cancel.textContent?.trim()).toBe('Cancelar Desligamento');

    cancel.click();
    await settle();
    expect(store.power).toHaveBeenLastCalledWith('CANCEL_SHUTDOWN', false);
    expect(root.querySelector('.cancel')).toBeNull();
  });

  it('sleep does not offer the countdown cancellation', async () => {
    action('Suspender').click();
    await settle();
    sheetButton('Suspender').click();
    await settle();
    expect(root.querySelector('.cancel')).toBeNull();
  });

  it('shows a failure of a direct action on the page', async () => {
    store.power.mockResolvedValueOnce(FAILURE);
    action('Bloquear').click();
    await settle();
    expect(root.querySelector('.error')?.textContent).toContain('O PC está desconectado.');
  });

  it('is all disabled while the PC is not connected', () => {
    store.phase.set('offline');
    fixture.detectChanges();
    expect([...root.querySelectorAll<HTMLButtonElement>('.action')].every((b) => b.disabled)).toBe(
      true,
    );
  });
});
