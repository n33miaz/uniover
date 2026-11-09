import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcSlideGoto } from './slide-goto';

describe('PcSlideGoto', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcSlideGoto>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  const field = () => root.querySelector<HTMLInputElement>('.goto-input')!;
  const go = () => root.querySelector<HTMLButtonElement>('.goto-go')!.click();

  beforeEach(() => {
    store = createFakePcStore();
    store.capabilities.set(['pc.key.v2']);
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PcSlideGoto);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('sends the digits and Enter, in order, and clears the field', async () => {
    field().value = ' 305 ';
    go();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['D3', []],
      ['D0', []],
      ['D5', []],
      ['ENTER', []],
    ]);
    expect(field().value).toBe('');
  });

  it.each(['', '0', 'abc', '1000', '-1', '1.5'])(
    'refuses %j with its own message and sends nothing',
    async (text) => {
      field().value = text;
      go();
      await flush();
      fixture.detectChanges();
      expect(store.sendKey).not.toHaveBeenCalled();
      expect(root.querySelector('.note')?.textContent).toContain('de 1 a 999');
    },
  );

  it('has a numeric field with its own name for the screen reader, and no browser validation bubble', () => {
    expect(field().getAttribute('inputmode')).toBe('numeric');
    expect(field().getAttribute('aria-label')).toBe('Número do slide');
    expect(root.querySelector('form')!.hasAttribute('novalidate')).toBe(true);
  });

  it('is not shown at all for a PC that does not understand the digits', () => {
    store.capabilities.set([]);
    fixture.detectChanges();
    expect(root.querySelector('form')).toBeNull();
  });

  it('with the Alt of the window switcher held it is off, sends nothing and keeps what was typed', async () => {
    field().value = '12';
    store.heldKeys.set(['ALT']);
    fixture.detectChanges();
    expect(field().disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.goto-go')!.disabled).toBe(true);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
    expect(field().value).toBe('12');
  });

  it('is disabled while the PC is not connected', async () => {
    store.phase.set('offline');
    fixture.detectChanges();
    expect(field().disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.goto-go')!.disabled).toBe(true);
  });
});
