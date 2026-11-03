import { TestBed } from '@angular/core/testing';
import { SiriSteps } from './siri-steps';

const TV = '11111111-1111-4111-8111-111111111111';
const APP = '22222222-2222-4222-8222-222222222222';

describe('SiriSteps', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  async function render(token: string | null, actions = ['volume_up', 'key:HOME', `app:${APP}`]) {
    const fixture = TestBed.createComponent(SiriSteps);
    fixture.componentRef.setInput('tvId', TV);
    fixture.componentRef.setInput('actions', actions);
    fixture.componentRef.setInput('appNames', new Map([[APP, 'Vídeo']]));
    fixture.componentRef.setInput('token', token);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const press = async (label: string, index = 0) => {
      el.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[index].click();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    };
    return { fixture, el, press };
  }

  it('makes one card per action, named with what to say to the assistant', async () => {
    const { el } = await render('atalho_abc');

    const phrases = Array.from(el.querySelectorAll('.phrase')).map((n) => n.textContent?.trim());
    expect(phrases).toEqual(['Aumentar o volume da TV', 'Tecla Início da TV', 'Abrir Vídeo na TV']);
  });

  it('shows the URL, the method, the header and the JSON fields of each action', async () => {
    const { el } = await render('atalho_abc', ['key:BACK']);

    const text = el.textContent ?? '';
    expect(text).toContain(`${location.origin}/api/v1/shortcuts/tv`);
    expect(text).toContain('POST');
    expect(text).toContain('X-Atalho-Token');
    expect(text).toContain('atalho_abc');
    expect(text).toContain(TV);
    expect(text).toContain('BACK');
  });

  it('marks where the key goes once the key is no longer at hand, and offers no way to copy it', async () => {
    const { el } = await render(null, ['mute']);

    expect(el.textContent).toContain('<sua chave>');
    expect(el.querySelector('button[aria-label="Copiar a chave"]')).toBeNull();
  });

  it('copies one value at a time and says so', async () => {
    const { el, press } = await render('atalho_abc', ['mute']);

    await press('Copiar URL');
    expect(writeText).toHaveBeenLastCalledWith(`${location.origin}/api/v1/shortcuts/tv`);
    expect(el.textContent).toContain('Copiado.');

    await press('Copiar a chave');
    expect(writeText).toHaveBeenLastCalledWith('atalho_abc');
  });

  it('copies the whole recipe, with the key', async () => {
    const { el } = await render('atalho_abc', ['mute']);

    Array.from(el.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Copiar tudo')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const copied = writeText.mock.calls.at(-1)![0] as string;
    expect(copied).toContain('Mudo na TV');
    expect(copied).toContain('X-Atalho-Token = atalho_abc');
    expect(copied).toContain(`tv = ${TV}`);
    expect(copied).toContain('action = mute');
  });

  it('says when the device does not let the page copy', async () => {
    writeText.mockRejectedValue(new Error('bloqueado'));
    const { el, press } = await render('atalho_abc', ['mute']);

    await press('Copiar URL');

    expect(el.textContent).toContain('Não deu para copiar sozinho');
  });
});
