import { TestBed } from '@angular/core/testing';
import { AUTH_CONFIG } from '../auth/auth.service';
import { ResumeGrace } from '../connectivity/resume-grace';
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

  describe('right after coming back to the app', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // Com temporizador falso `whenStable` nunca volta: cria e desenha à mão.
    const create = () => {
      const fixture = TestBed.createComponent(SessionNotice);
      fixture.detectChanges();
      return fixture;
    };

    const notice = (fixture: { nativeElement: unknown }) =>
      (fixture.nativeElement as HTMLElement).querySelector('.notice');

    it('does not show the banner while the grace period lasts, and keeps waiting for the quick retry', async () => {
      const session = TestBed.inject(SessionState);
      const grace = TestBed.inject(ResumeGrace);
      const fixture = create();
      grace.begin();
      session.setPending();
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(notice(fixture)).toBeNull();

      // Passou a carência, mas a repetição rápida da renovação ainda não saiu: segue calada.
      await vi.advanceTimersByTimeAsync(5_000);
      fixture.detectChanges();
      expect(notice(fixture)).toBeNull();
    });

    it('shows the banner if the session is still pending after the quick retry should have happened', async () => {
      const session = TestBed.inject(SessionState);
      const grace = TestBed.inject(ResumeGrace);
      const fixture = create();
      grace.begin();
      session.setPending();
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(TestBed.inject(AUTH_CONFIG).lostResponseRetryMs + 2_000);
      fixture.detectChanges();
      expect(notice(fixture)?.textContent).toContain('Sessão a confirmar');
    });

    it('never shows the banner when the renewal works during the wait', async () => {
      const session = TestBed.inject(SessionState);
      const grace = TestBed.inject(ResumeGrace);
      const fixture = create();
      grace.begin();
      session.setPending();
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      session.setToken('t', 600);
      await vi.advanceTimersByTimeAsync(10_000);
      fixture.detectChanges();
      expect(notice(fixture)).toBeNull();
    });

    it('a pending session that began outside the grace period shows at once, as before', async () => {
      const session = TestBed.inject(SessionState);
      session.setPending();
      const fixture = create();
      fixture.detectChanges();
      expect(notice(fixture)?.textContent).toContain('Sessão a confirmar');
    });
  });
});
