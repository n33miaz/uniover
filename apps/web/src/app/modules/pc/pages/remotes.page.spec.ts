import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { PcStore } from '../data/pc-store';
import { PC_KEY_V2_CAPABILITY } from '../data/pc-types';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PC_ROUTES, REMOTE_BACK, REMOTES_LIST_BACK } from '../pc.routes';
import { RemotePage, RemotesPage } from './remotes.page';

describe('Controles', () => {
  let store: FakePcStore;

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({
      providers: [
        { provide: PcStore, useValue: store },
        provideRouter([
          { path: 'pc/controles', component: RemotesPage },
          { path: 'pc/controles/:app', component: RemotePage },
        ]),
      ],
    });
  });

  it('lists one wide row per program, each a link to its panel, with no explanatory text', async () => {
    store.capabilities.set([PC_KEY_V2_CAPABILITY]);
    const harness = await RouterTestingHarness.create('/pc/controles');
    const root = harness.routeNativeElement!;
    const rows = [...root.querySelectorAll('a.row')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      'Navegador',
      'YouTube',
      'Netflix',
      'Spotify',
      'VLC',
      'Teclado Numérico',
    ]);
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/pc/controles/navegador',
      '/pc/controles/youtube',
      '/pc/controles/netflix',
      '/pc/controles/spotify',
      '/pc/controles/vlc',
      '/pc/controles/teclado-numerico',
    ]);
    expect(root.querySelectorAll('p')).toHaveLength(0);
  });

  it('without pc.key.v2 the number pad is not on the list', async () => {
    const harness = await RouterTestingHarness.create('/pc/controles');
    const names = [...harness.routeNativeElement!.querySelectorAll('a.row')].map((row) =>
      row.textContent?.trim(),
    );
    expect(names).not.toContain('Teclado Numérico');
    expect(names).toHaveLength(5);
  });

  it('a program opens with its name and its pad, and no back arrow of its own', async () => {
    const harness = await RouterTestingHarness.create('/pc/controles/netflix');
    const root = harness.routeNativeElement!;
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Netflix');
    expect(root.querySelector('app-pc-remote-pad')).toBeTruthy();
    expect(root.querySelectorAll('a')).toHaveLength(0);
  });

  it('an unknown program, or the number pad on an old agent, shows nothing', async () => {
    const harness = await RouterTestingHarness.create('/pc/controles/winamp');
    expect(harness.routeNativeElement!.querySelector('app-pc-remote-pad')).toBeNull();
    await harness.navigateByUrl('/pc/controles/teclado-numerico');
    expect(harness.routeNativeElement!.querySelector('app-pc-remote-pad')).toBeNull();
    expect(harness.routeNativeElement!.querySelector('h2')).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/pc/controles/teclado-numerico');
  });
});

describe('the one back arrow of the Controls (the app header)', () => {
  const child = (path: string) => PC_ROUTES[0].children!.find((route) => route.path === path)!;

  it('the list goes back to the More tab, and an open program to the list', () => {
    expect(child('controles').data?.['back']).toEqual(REMOTES_LIST_BACK);
    expect(REMOTES_LIST_BACK.link).toBe('/pc/mais');
    expect(child('controles/:app').data?.['back']).toEqual(REMOTE_BACK);
    expect(REMOTE_BACK.link).toBe('/pc/controles');
    expect(REMOTE_BACK.label).toBe('Voltar aos Controles');
  });
});
