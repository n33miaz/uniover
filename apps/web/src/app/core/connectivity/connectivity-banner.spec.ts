import { TestBed } from '@angular/core/testing';
import { ConnectivityBanner, WAKING_NOTICE_DELAY_MS } from './connectivity-banner';
import { ConnectivityService } from './connectivity.service';

describe('ConnectivityBanner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Monta a faixa e deixa passar `elapsedMs` (por padrão, o bastante para o "iniciando" aparecer). */
  async function render(elapsedMs = WAKING_NOTICE_DELAY_MS) {
    const fixture = TestBed.createComponent(ConnectivityBanner);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(elapsedMs);
    fixture.detectChanges();
    return fixture;
  }
  const text = (f: { nativeElement: unknown }) =>
    (f.nativeElement as HTMLElement).textContent ?? '';

  it('shows nothing when everything is fine, but keeps the live region', async () => {
    const fixture = await render();
    expect(text(fixture).trim()).toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="status"]')).not.toBeNull();
  });

  it('shows the waking curtain with the seconds waited', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.serverState.set('waking');
    service.waitedSeconds.set(12);
    const fixture = await render();
    expect(text(fixture)).toContain('O UniOver está iniciando');
    expect(text(fixture)).toContain('aguardando há 12 s');
  });

  it('a waking state that clears in under two seconds never shows (no blink when the app opens)', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.serverState.set('waking');
    const fixture = await render(WAKING_NOTICE_DELAY_MS - 1);
    expect(text(fixture).trim()).toBe('');
    service.serverState.set('ok');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(WAKING_NOTICE_DELAY_MS * 2);
    fixture.detectChanges();
    expect(text(fixture).trim()).toBe('');
  });

  it('a waking state that lasts shows up, and leaves as soon as the server answers', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.serverState.set('waking');
    const fixture = await render(WAKING_NOTICE_DELAY_MS - 1);
    expect(text(fixture)).not.toContain('O UniOver está iniciando');
    await vi.advanceTimersByTimeAsync(1);
    fixture.detectChanges();
    expect(text(fixture)).toContain('O UniOver está iniciando');
    service.serverState.set('ok');
    fixture.detectChanges();
    expect(fixture.componentInstance['shown']()).toBe('ok');
  });

  it('the offline notice is never held back', async () => {
    TestBed.inject(ConnectivityService).serverState.set('offline');
    expect(text(await render(0))).toContain('Sem conexão');
  });

  it('draws the state dot before the line: filled while waking, hollow when offline', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.serverState.set('waking');
    const waking = (await render()).nativeElement as HTMLElement;
    expect(waking.querySelector('.banner.waking > .dot[aria-hidden="true"]')).not.toBeNull();
    service.serverState.set('offline');
    const offline = (await render()).nativeElement as HTMLElement;
    expect(offline.querySelector('.banner.offline > .dot[aria-hidden="true"]')).not.toBeNull();
  });

  it('opens and closes each notice inside a collapsible track, so the page below does not jump', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.serverState.set('waking');
    const waking = (await render()).nativeElement as HTMLElement;
    expect(
      waking.querySelector('.slot > .ui-collapse > .ui-collapse-inner > .banner.waking'),
    ).not.toBeNull();
    service.serverState.set('offline');
    const offline = (await render()).nativeElement as HTMLElement;
    expect(
      offline.querySelector('.slot > .ui-collapse > .ui-collapse-inner > .banner.offline'),
    ).not.toBeNull();
  });

  it('shows the offline notice without the curtain', async () => {
    TestBed.inject(ConnectivityService).serverState.set('offline');
    const fixture = await render();
    expect(text(fixture)).toContain('Sem conexão');
    expect(text(fixture)).not.toContain('iniciando');
  });

  it('says the server did not answer once the window is over', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.serverState.set('offline');
    service.windowExpired.set(true);
    expect(text(await render())).toContain('não respondeu');
  });
});
