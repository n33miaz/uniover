import { TestBed } from '@angular/core/testing';
import { SyncStatusLine } from './sync-status-line';

async function render(inputs: { pending?: number; failed?: number; lastSyncAt?: number | null }) {
  const fixture = TestBed.createComponent(SyncStatusLine);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    text: () => el.querySelector('[role="status"]')?.textContent?.trim() ?? '',
  };
}

describe('SyncStatusLine', () => {
  it('always renders a status region, empty when there is nothing to say', async () => {
    const { el, text } = await render({});
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(text()).toBe('');
  });

  it('says how many are not synchronized yet, in singular and plural', async () => {
    expect((await render({ pending: 1 })).text()).toBe('1 ainda não sincronizado');
    expect((await render({ pending: 3 })).text()).toBe('3 ainda não sincronizados');
  });

  it('says how many have an error and does not hide that behind the sync time', async () => {
    expect((await render({ failed: 1, lastSyncAt: Date.now() })).text()).toBe('1 com erro');
    expect((await render({ failed: 2 })).text()).toBe('2 com erro');
    expect((await render({ pending: 2, failed: 1 })).text()).toBe(
      '2 ainda não sincronizados · 1 com erro',
    );
  });

  it('shows the time of the last synchronization once nothing is pending', async () => {
    const at = new Date(2026, 9, 18, 14, 5).getTime();
    expect((await render({ lastSyncAt: at })).text()).toBe('sincronizado às 14:05');
  });

  it('marks errors with a distinct class and updates when the inputs change', async () => {
    const { fixture, el, text } = await render({ pending: 1 });
    expect(text()).toBe('1 ainda não sincronizado');
    fixture.componentRef.setInput('pending', 0);
    fixture.componentRef.setInput('failed', 1);
    await fixture.whenStable();
    expect(el.querySelector('.error')?.textContent).toContain('1 com erro');
  });
});
