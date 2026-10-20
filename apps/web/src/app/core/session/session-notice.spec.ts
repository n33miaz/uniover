import { TestBed } from '@angular/core/testing';
import { SessionNotice } from './session-notice';
import { SessionState } from './session-state';

describe('SessionNotice', () => {
  async function render() {
    const fixture = TestBed.createComponent(SessionNotice);
    await fixture.whenStable();
    return fixture;
  }

  it('is silent while the session is confirmed', async () => {
    TestBed.inject(SessionState).setToken('t', 600);
    const fixture = await render();
    expect((fixture.nativeElement as HTMLElement).querySelector('.notice')).toBeNull();
  });

  it('announces a session waiting for confirmation, in a status region, and clears when confirmed', async () => {
    const session = TestBed.inject(SessionState);
    session.setPending();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="status"] .notice')?.textContent).toContain(
      'Sessão a confirmar',
    );
    expect(el.textContent).toContain('nada foi apagado');
    expect(el.querySelector('.ui-collapse > .ui-collapse-inner > .notice')).not.toBeNull();

    session.setToken('t', 600);
    fixture.detectChanges();
    expect(el.querySelector('.notice')).toBeNull();
  });
});
