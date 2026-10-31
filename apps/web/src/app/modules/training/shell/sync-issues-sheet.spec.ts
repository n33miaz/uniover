import { TestBed } from '@angular/core/testing';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { NEW_ITEM } from '../../../core/offline-queue/queue-test-kit';
import { SyncIssuesSheet } from './sync-issues-sheet';
import { eventually, setupScreen } from './screen-test-kit';

describe('SyncIssuesSheet', () => {
  async function render(failed: { url: string; body: unknown; error: string }[]) {
    const kit = await setupScreen();
    const ids: string[] = [];
    for (const entry of failed) {
      const id = await kit.queue().enqueue({ ...NEW_ITEM, url: entry.url, body: entry.body });
      const stored = (await kit.store().get(id))!;
      await kit.store().markFailed(id, stored.revision, entry.error);
      ids.push(id);
    }
    const fixture = TestBed.createComponent(SyncIssuesSheet);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    await fixture.whenStable();
    fixture.detectChanges();
    return { ...kit, ids, fixture, closed, el: fixture.nativeElement as HTMLElement };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const issues = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('.issue'));
  const button = (scope: ParentNode, label: string) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((node) =>
      node.textContent?.trim().startsWith(label),
    )!;

  const ROUTINE = {
    url: '/api/v1/training/routines/r1',
    body: { name: 'Treino A' },
    error: 'http-422:client-clock-ahead',
  };
  const EXERCISE = {
    url: '/api/v1/training/exercises/e1',
    body: { name: 'Remada' },
    error: 'http-403',
  };

  it('lists only what the server refused, with the kind, the name and the reason', async () => {
    const { fixture, el, queue } = await render([ROUTINE, EXERCISE]);
    await queue().enqueue({
      ...NEW_ITEM,
      url: '/api/v1/training/routines/ok',
      body: { name: 'Ainda na fila' },
    });
    await eventually(fixture, () => expect(issues(el)).toHaveLength(2));
    expect(el.querySelector('dialog')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(text(el)).toContain('Alterações com Erro');
    expect(issues(el)[0].textContent).toContain('Rotina');
    expect(issues(el)[0].textContent).toContain('“Treino A”');
    expect(issues(el)[0].textContent).toContain('relógio');
    expect(issues(el)[1].textContent).toContain('Exercício');
    expect(issues(el)[1].textContent).toContain('403');
    expect(text(el)).not.toContain('Ainda na fila');
  });

  it('names each button after the record, so "Tentar de Novo" is not the same for all', async () => {
    const { fixture, el } = await render([ROUTINE, EXERCISE]);
    await eventually(fixture, () => expect(issues(el)).toHaveLength(2));
    const labels = Array.from(el.querySelectorAll('.issue button')).map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(labels).toContain('Tentar de novo: Rotina “Treino A”');
    expect(labels).toContain('Descartar: Exercício “Remada”');
  });

  it('sends the item again only when asked, and it goes back to pending with the same key', async () => {
    const { fixture, el, store, ids } = await render([ROUTINE]);
    await eventually(fixture, () => expect(issues(el)).toHaveLength(1));
    expect((await store().get(ids[0]))?.status).toBe('failed');
    button(el, 'Tentar de Novo').click();
    await vi.waitFor(async () => expect((await store().get(ids[0]))?.status).not.toBe('failed'));
    expect((await store().get(ids[0]))?.id).toBe(ids[0]);
  });

  it('does not discard on its own: the item stays after the sheet has been opened and read', async () => {
    const { fixture, el, store, ids } = await render([ROUTINE]);
    await eventually(fixture, () => expect(issues(el)).toHaveLength(1));
    expect((await store().get(ids[0]))?.status).toBe('failed');
    expect(await TestBed.inject(OfflineQueue).items()).toHaveLength(1);
  });

  it('asks before discarding, "Manter" gives up, and only the confirmation discards', async () => {
    const { fixture, el, store, ids } = await render([ROUTINE, EXERCISE]);
    await eventually(fixture, () => expect(issues(el)).toHaveLength(2));
    button(issues(el)[0], 'Descartar').click();
    fixture.detectChanges();
    expect(issues(el)[0].textContent).toContain('Descartar esta alteração?');
    expect(await store().get(ids[0])).toBeDefined();
    button(issues(el)[0], 'Manter').click();
    fixture.detectChanges();
    expect(issues(el)[0].querySelector('.confirm')).toBeNull();
    expect(await store().get(ids[0])).toBeDefined();

    button(issues(el)[0], 'Descartar').click();
    fixture.detectChanges();
    button(issues(el)[0].querySelector('.confirm')!, 'Descartar').click();
    await vi.waitFor(async () => expect(await store().get(ids[0])).toBeUndefined());
    await eventually(fixture, () => expect(issues(el)).toHaveLength(1));
    // O outro item não foi tocado.
    expect(await store().get(ids[1])).toBeDefined();
  });

  it('goes down by itself when the last refused item leaves the queue', async () => {
    const { fixture, el, closed } = await render([ROUTINE]);
    await eventually(fixture, () => expect(issues(el)).toHaveLength(1));
    button(issues(el)[0], 'Descartar').click();
    fixture.detectChanges();
    button(issues(el)[0].querySelector('.confirm')!, 'Descartar').click();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  });
});
