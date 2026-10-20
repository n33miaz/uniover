import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WidgetPref } from '../../core/modules/module-prefs';
import { HomeEditSheet } from './home-edit-sheet';

const initial: WidgetPref[] = [
  { id: 'tv', size: 'small', enabled: true },
  { id: 'training', size: 'wide', enabled: true },
];

@Component({
  imports: [HomeEditSheet],
  template: `<app-home-edit-sheet
    [widgets]="widgets()"
    (applied)="applied = $event"
    (cancelled)="cancelled = true"
  />`,
})
class Host {
  widgets = signal(initial);
  applied: readonly WidgetPref[] | null = null;
  cancelled = false;
}

describe('HomeEditSheet', () => {
  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement, fixture };
  }

  it('opens as a modal dialog without a close button', async () => {
    const { el } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('sheet-title');
    const buttons = Array.from(dialog.querySelectorAll('.footer button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(buttons).toEqual(['Cancelar', 'Aplicar']);
  });

  it('disables moving up the first and down the last, with accessible names', async () => {
    const { el } = await render();
    const up = el.querySelectorAll<HTMLButtonElement>('.up');
    const down = el.querySelectorAll<HTMLButtonElement>('.down');
    expect(up[0].disabled).toBe(true);
    expect(down[1].disabled).toBe(true);
    expect(down[0].getAttribute('aria-label')).toBe('Descer TV');
    expect(up[1].getAttribute('aria-label')).toBe('Subir Treino');
  });

  it('applies the edited order, size and visibility', async () => {
    const { host, el, fixture } = await render();
    el.querySelector<HTMLButtonElement>('.down')!.click();
    await fixture.whenStable();
    el.querySelectorAll<HTMLButtonElement>('.size')[1].click(); // primeiro item (agora Treino): Largo já; mexe no segundo
    const checkbox = el.querySelectorAll<HTMLInputElement>('.show input')[1];
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.primary')!.click();
    expect(host.applied?.map((w) => w.id)).toEqual(['training', 'tv']);
    expect(host.applied?.[1].enabled).toBe(false);
  });

  it('cancels with Cancelar and with the native cancel event (Esc)', async () => {
    const first = await render();
    first.el.querySelector<HTMLButtonElement>('.secondary')!.click();
    expect(first.host.cancelled).toBe(true);
    expect(first.host.applied).toBeNull();

    const second = await render();
    second.el.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(second.host.cancelled).toBe(true);
  });

  it('lists the planned modules too, each with its name and its own glyph', async () => {
    // A folha copia a lista ao abrir: a lista completa tem de estar pronta antes da primeira renderização.
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.widgets.set([
      ...initial,
      ...['health', 'monitor', 'network', 'backup', 'notifications', 'pc'].map((id) => ({
        id,
        size: 'small' as const,
        enabled: true,
      })),
    ]);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const names = Array.from(el.querySelectorAll('.row .name')).map((n) => n.textContent?.trim());
    expect(names).toEqual([
      'TV',
      'Treino',
      'Saúde e eventos',
      'Monitor dos serviços',
      'Rede da casa',
      'Backup de fotos',
      'Avisos',
      'Controle do PC',
    ]);
    const drawings = Array.from(el.querySelectorAll('.row .ico')).map((icon) =>
      Array.from(icon.querySelectorAll('path'))
        .map((path) => path.getAttribute('d'))
        .join('|'),
    );
    expect(new Set(drawings).size).toBe(8);
  });

  it('goes down before telling the parent, and a second tap during the exit changes nothing', async () => {
    const { host, el } = await render();
    let end!: () => void;
    const finished = new Promise<void>((resolve) => (end = resolve));
    const dialog = el.querySelector('dialog')!;
    dialog.getAnimations = () =>
      [
        { finished, effect: { getComputedTiming: () => ({ iterations: 1 }) } },
      ] as unknown as Animation[];

    el.querySelector<HTMLButtonElement>('.primary')!.click();
    expect(dialog.classList.contains('closing')).toBe(true);
    expect(host.applied).toBeNull();

    el.querySelector<HTMLButtonElement>('.secondary')!.click(); // tarde demais para cancelar
    end();
    await vi.waitFor(() => expect(host.applied).not.toBeNull());
    expect(host.cancelled).toBe(false);
  });

  it('reorders by dragging the handle over another row', async () => {
    const { host, el, fixture } = await render();
    const rows = el.querySelectorAll<HTMLElement>('.row');
    const doc = el.ownerDocument;
    (doc as { elementFromPoint?: unknown }).elementFromPoint = () => rows[1];
    const grip = rows[0].querySelector('.grip')!;
    grip.dispatchEvent(new Event('pointerdown'));
    grip.dispatchEvent(new Event('pointermove'));
    grip.dispatchEvent(new Event('pointerup'));
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.primary')!.click();
    expect(host.applied?.map((w) => w.id)).toEqual(['training', 'tv']);
  });
});
