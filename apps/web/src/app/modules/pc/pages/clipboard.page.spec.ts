import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FAILURE, FakePcStore, createFakePcStore } from '../pc-test-kit';
import { ClipboardPage } from './clipboard.page';

describe('ClipboardPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<ClipboardPage>>;
  let root: HTMLElement;

  const button = (action: string) =>
    root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!;
  const draft = () => root.querySelectorAll<HTMLTextAreaElement>('textarea:not([readonly])')[0];
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  function type(text: string): void {
    draft().value = text;
    draft().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    store = createFakePcStore();
    store.capabilities.set(['pc.clipboard.v1', 'pc.clipboard.read.v1']);
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(ClipboardPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('tells to update the agent of a PC that did not declare it, and offers nothing', () => {
    store.capabilities.set([]);
    fixture.detectChanges();
    expect(root.textContent).toContain('Atualize o agente do PC');
    expect(root.querySelector('button')).toBeNull();
  });

  it('brings the text of the PC only when asked, and shows it', async () => {
    expect(store.readClipboard).not.toHaveBeenCalled();
    store.readClipboard.mockResolvedValueOnce({ ok: true, value: 'texto do PC' });
    button('read').click();
    await settle();
    expect(store.readClipboard).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value).toBe(
      'texto do PC',
    );
  });

  it('says when the PC has no text copied', async () => {
    store.readClipboard.mockResolvedValueOnce({ ok: true, value: '' });
    button('read').click();
    await settle();
    expect(root.querySelector('textarea[readonly]')).toBeNull();
    expect(root.textContent).toContain('não tem texto');
  });

  it('forgets the text on "Limpar"', async () => {
    store.readClipboard.mockResolvedValueOnce({ ok: true, value: 'senha' });
    button('read').click();
    await settle();
    button('forget').click();
    fixture.detectChanges();
    expect(root.querySelector('textarea[readonly]')).toBeNull();
    expect(root.textContent).not.toContain('senha');
  });

  it('copies the text into this device', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    store.readClipboard.mockResolvedValueOnce({ ok: true, value: 'texto do PC' });
    button('read').click();
    await settle();
    button('copy').click();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('texto do PC');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Copiado');
  });

  it('shows the failure of a read', async () => {
    store.readClipboard.mockResolvedValueOnce({ ok: false, failure: FAILURE });
    button('read').click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('O PC está desconectado.');
  });

  it('sends the typed text to the PC and clears the field', async () => {
    expect(button('write').disabled).toBe(true);
    type('para colar no PC');
    expect(button('write').disabled).toBe(false);
    button('write').click();
    await settle();
    expect(store.writeClipboard).toHaveBeenCalledExactlyOnceWith('para colar no PC');
    expect(draft().value).toBe('');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('colar no PC');
  });

  it('keeps the text and shows the failure when the PC refused it', async () => {
    store.writeClipboard.mockResolvedValueOnce(FAILURE);
    type('texto');
    button('write').click();
    await settle();
    expect(draft().value).toBe('texto');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('O PC está desconectado.');
  });

  it('never sends a text outside the contract', () => {
    type('a\u0000b');
    expect(button('write').disabled).toBe(true);
  });

  it('is all disabled while the PC is not connected', () => {
    store.phase.set('offline');
    type('texto');
    expect(button('read').disabled).toBe(true);
    expect(button('write').disabled).toBe(true);
  });
});
