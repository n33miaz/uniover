import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TRAINING_ONLY, TV_CONTROL_ONLY } from './people-permissions';
import { PeoplePermissionPicker } from './people-permission-picker';

@Component({
  selector: 'app-picker-host',
  imports: [PeoplePermissionPicker],
  template: `<app-people-permission-picker [(permissions)]="list" [showSummary]="showSummary()" />`,
})
class Host {
  readonly list = signal<readonly string[]>([...TV_CONTROL_ONLY]);
  readonly showSummary = signal(true);
}

describe('PeoplePermissionPicker', () => {
  async function render(initial: readonly string[] = TV_CONTROL_ONLY) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.list.set([...initial]);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const options = () =>
      Array.from(el.querySelectorAll<HTMLElement>('label.option')).map((row) => ({
        text: row.querySelector('.option-title')?.textContent?.trim(),
        input: row.querySelector<HTMLInputElement>('input')!,
      }));
    const option = (text: string) => options().find((o) => o.text === text)!.input;
    const flip = async (text: string) => {
      option(text).click();
      await fixture.whenStable();
    };
    const model = (text: string) =>
      Array.from(el.querySelectorAll<HTMLLabelElement>('label.model')).find(
        (label) => label.textContent?.trim() === text,
      )!;
    const chosenModel = () =>
      Array.from(el.querySelectorAll<HTMLLabelElement>('label.model'))
        .filter((label) => label.querySelector('input')!.checked)
        .map((label) => label.textContent?.trim());
    const pick = async (text: string) => {
      model(text).querySelector('input')!.click();
      await fixture.whenStable();
    };
    const list = () => fixture.componentInstance.list();
    const summary = () => el.querySelector('.summary')?.textContent?.replace(/\s+/g, ' ').trim();
    return { fixture, el, options, option, flip, model, chosenModel, pick, list, summary };
  }

  it('lists the ready-made models first, then the TV and the Training in plain words', async () => {
    const { el, options } = await render();
    expect(
      Array.from(el.querySelectorAll('label.model')).map((label) => label.textContent?.trim()),
    ).toEqual(['Só controlar a TV', 'Só o Treino', 'Personalizado']);
    expect(Array.from(el.querySelectorAll('legend')).map((l) => l.textContent?.trim())).toEqual([
      'Modelos prontos',
      'TV',
      'Treino',
      'Controle do PC',
    ]);
    expect(options().map((o) => o.text)).toEqual([
      'Ver a TV',
      'Usar o controle e o teclado',
      'Desligar a TV',
      'Abrir apps e atualizar a lista',
      'Editar e reordenar atalhos',
      'Ver o histórico',
      'Usar o Treino',
      'Controlar o PC',
    ]);
  });

  it('groups with fieldset and legend, and every switch is a real labelled switch', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('fieldset')).toHaveLength(4);
    const switches = el.querySelectorAll<HTMLInputElement>('input[role="switch"]');
    expect(switches).toHaveLength(8);
    for (const input of Array.from(switches)) {
      expect(input.type).toBe('checkbox');
      expect(input.closest('label')?.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  it('shows the switches the list has turned on, and the model it matches', async () => {
    const { option, chosenModel } = await render();
    expect(option('Ver a TV').checked).toBe(true);
    expect(option('Desligar a TV').checked).toBe(true);
    expect(option('Editar e reordenar atalhos').checked).toBe(false);
    expect(option('Usar o Treino').checked).toBe(false);
    expect(chosenModel()).toEqual(['Só controlar a TV']);
  });

  it('the PC control is a module of its own: turning it on needs nothing else, and it keeps the others', async () => {
    const { flip, option, list } = await render(['module:training']);
    expect(option('Controlar o PC').checked).toBe(false);
    await flip('Controlar o PC');
    expect(option('Controlar o PC').checked).toBe(true);
    expect(list()).toEqual(['module:training', 'module:pc']);
    await flip('Controlar o PC');
    expect(list()).toEqual(['module:training']);
  });

  it('turning on a TV action turns on "see the TV" first', async () => {
    const { flip, option, list } = await render(['module:training']);
    expect(option('Ver a TV').checked).toBe(false);
    await flip('Editar e reordenar atalhos');
    expect(option('Ver a TV').checked).toBe(true);
    expect(option('Editar e reordenar atalhos').checked).toBe(true);
    expect(list()).toEqual(['module:tv', 'tv:edit-shortcuts', 'module:training']);
  });

  it('turning off "see the TV" turns off every TV action and keeps the Training', async () => {
    const { flip, option, list } = await render([...TV_CONTROL_ONLY, 'module:training']);
    await flip('Ver a TV');
    for (const text of [
      'Ver a TV',
      'Usar o controle e o teclado',
      'Desligar a TV',
      'Ver o histórico',
    ]) {
      expect(option(text).checked).toBe(false);
    }
    expect(option('Usar o Treino').checked).toBe(true);
    expect(list()).toEqual(['module:training']);
  });

  it('never refuses a flip: the DOM and the list never disagree, even turning everything off', async () => {
    const { flip, options, list } = await render(['module:training']);
    await flip('Usar o Treino');
    expect(list()).toEqual([]);
    expect(options().every((o) => !o.input.checked)).toBe(true);
    await flip('Usar o Treino');
    expect(list()).toEqual(['module:training']);
    expect(
      options()
        .filter((o) => o.input.checked)
        .map((o) => o.text),
    ).toEqual(['Usar o Treino']);
  });

  it('choosing a model replaces what was chosen and moves the switches', async () => {
    const { pick, option, list, chosenModel } = await render();
    await pick('Só o Treino');
    expect(list()).toEqual([...TRAINING_ONLY]);
    expect(option('Usar o Treino').checked).toBe(true);
    expect(option('Ver a TV').checked).toBe(false);
    expect(chosenModel()).toEqual(['Só o Treino']);
    await pick('Só controlar a TV');
    expect(list()).toEqual([...TV_CONTROL_ONLY]);
    expect(option('Usar o Treino').checked).toBe(false);
    expect(chosenModel()).toEqual(['Só controlar a TV']);
  });

  it('"Personalizado" keeps the list and stays selected until a switch moves', async () => {
    const { pick, flip, list, chosenModel } = await render();
    await pick('Personalizado');
    expect(list()).toEqual([...TV_CONTROL_ONLY]);
    expect(chosenModel()).toEqual(['Personalizado']);
    await flip('Editar e reordenar atalhos');
    expect(chosenModel()).toEqual(['Personalizado']);
    // Voltando a bater com um modelo, ele é o que aparece.
    await flip('Editar e reordenar atalhos');
    expect(chosenModel()).toEqual(['Só controlar a TV']);
  });

  it('moving a switch away from a model makes it custom', async () => {
    const { flip, chosenModel } = await render();
    await flip('Desligar a TV');
    expect(chosenModel()).toEqual(['Personalizado']);
  });

  it('always shows a one-line summary of what the person will be able to do', async () => {
    const { flip, summary } = await render();
    expect(summary()).toBe('Poderá: Controlar a TV · Desligar a TV · Abrir apps · Ver o histórico');
    await flip('Desligar a TV');
    expect(summary()).toBe('Poderá: Controlar a TV · Abrir apps · Ver o histórico');
  });

  it('leaves the summary to the host when told to, so a long sheet can pin it in its footer', async () => {
    const { fixture, el } = await render();
    expect(el.querySelector('.summary')).not.toBeNull();
    fixture.componentInstance.showSummary.set(false);
    await fixture.whenStable();
    expect(el.querySelector('.summary')).toBeNull();
  });

  it('warns, instead of summarizing, when no module is on', async () => {
    const { el, flip, summary } = await render(['module:training']);
    await flip('Usar o Treino');
    expect(summary()).toContain('Ligue ao menos um módulo');
    expect(el.querySelector('.summary')?.classList.contains('warn')).toBe(true);
    expect(el.querySelector('.summary')?.getAttribute('role')).toBe('status');
  });

  it('keeps a permission the screen cannot name when other switches move', async () => {
    const { flip, list } = await render([...TV_CONTROL_ONLY, 'module:audit']);
    await flip('Usar o Treino');
    expect(list()).toEqual([...TV_CONTROL_ONLY, 'module:training', 'module:audit']);
  });
});
