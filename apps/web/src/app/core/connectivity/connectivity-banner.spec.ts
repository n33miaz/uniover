import { TestBed } from '@angular/core/testing';
import { ConnectivityBanner } from './connectivity-banner';
import { ConnectivityService } from './connectivity.service';

describe('ConnectivityBanner', () => {
  async function render() {
    const fixture = TestBed.createComponent(ConnectivityBanner);
    await fixture.whenStable();
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
    expect(text(fixture)).toContain('Acordando o servidor');
    expect(text(fixture)).toContain('aguardando há 12 s');
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
    expect(text(fixture)).not.toContain('Acordando');
  });

  it('says the server did not answer once the window is over', async () => {
    const service = TestBed.inject(ConnectivityService);
    service.serverState.set('offline');
    service.windowExpired.set(true);
    expect(text(await render())).toContain('não respondeu');
  });
});
