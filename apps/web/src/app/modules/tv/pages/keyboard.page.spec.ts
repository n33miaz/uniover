import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { KeyboardPage } from './keyboard.page';

describe('KeyboardPage', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<KeyboardPage>>;
  let root: HTMLElement;
  const navigate = vi.fn<(url: string) => Promise<boolean>>();

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const input = () => root.querySelector<HTMLInputElement>('#tv-text')!;
  const sendButton = () => root.querySelector<HTMLButtonElement>('.primary')!;
  const type = async (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    await render();
  };
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };

  beforeEach(async () => {
    store = createFakeTvStore();
    navigate.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigateByUrl: navigate } },
        { provide: TvStore, useValue: store },
      ],
    });
    fixture = TestBed.createComponent(KeyboardPage);
    root = fixture.nativeElement;
    await render();
  });

  it('warns that the text goes to whatever field is open on the TV', () => {
    expect(root.textContent).toContain('O texto é escrito no campo que estiver aberto na TV.');
    expect(root.querySelector('label')?.textContent?.trim()).toBe('Texto para a TV');
  });

  it('starts empty with Enviar disabled and the counter at zero', () => {
    expect(input().value).toBe('');
    expect(sendButton().disabled).toBe(true);
    expect(root.querySelector('.count')?.textContent?.trim()).toBe('0 / 200');
  });

  it('sends the text and forgets it afterwards', async () => {
    await type('batman');
    expect(root.querySelector('.count')?.textContent?.trim()).toBe('6 / 200');
    expect(sendButton().disabled).toBe(false);
    await submit();
    expect(store.sendText).toHaveBeenCalledWith('batman');
    expect(input().value).toBe('');
    expect(sendButton().disabled).toBe(true);
  });

  it('keeps the text to try again when sending fails', async () => {
    store.sendText.mockResolvedValueOnce(false);
    await type('batman');
    await submit();
    expect(input().value).toBe('batman');
  });

  it('refuses more than 200 characters', async () => {
    await type('a'.repeat(201));
    expect(sendButton().disabled).toBe(true);
    expect(root.querySelector('.count')?.classList.contains('over')).toBe(true);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    await submit();
    expect(store.sendText).not.toHaveBeenCalled();
  });

  it('counts characters, not UTF-16 units', async () => {
    await type('😀'.repeat(200));
    expect(root.querySelector('.count')?.textContent?.trim()).toBe('200 / 200');
    expect(sendButton().disabled).toBe(false);
  });

  it('cannot send while the remote cannot send', async () => {
    store.canSend.set(false);
    await type('batman');
    expect(sendButton().disabled).toBe(true);
  });

  it('Cancelar clears the field and goes back to the remote', async () => {
    await type('batman');
    root.querySelector<HTMLButtonElement>('.secondary')!.click();
    await render();
    expect(input().value).toBe('');
    expect(navigate).toHaveBeenCalledWith('/tv');
    expect(store.sendText).not.toHaveBeenCalled();
  });

  it('turns off autocorrect and capitalization for a field that goes to a TV', () => {
    expect(input().getAttribute('autocapitalize')).toBe('off');
    expect(input().getAttribute('autocorrect')).toBe('off');
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().getAttribute('spellcheck')).toBe('false');
  });
});
