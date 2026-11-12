import { TestBed } from '@angular/core/testing';
import { TvAdbPermission } from '../data/tv-adb-permission';
import { TvApi } from '../data/tv-api';
import { TvStore } from '../data/tv-store';
import type { TvWakeHint } from '../data/tv-types';
import { FakeTvStore, HOT, createFakeTvStore } from '../tv-test-kit';
import { WakeNotice } from './wake-notice';

describe('WakeNotice', () => {
  let store: FakeTvStore;
  let permission: TvAdbPermission;
  let fixture: ReturnType<typeof TestBed.createComponent<WakeNotice>>;
  let root: HTMLElement;

  const notice = () => root.querySelector<HTMLElement>('.notice');
  const text = () =>
    (notice()?.querySelector('.text')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const withHints = (wakeHints: readonly TvWakeHint[], agentOnline = true) => {
    store.state.set({ ...HOT, agentOnline, wakeHints });
    fixture.detectChanges();
  };

  beforeEach(() => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [
        { provide: TvStore, useValue: store },
        {
          provide: TvApi,
          useValue: { refreshShortcuts: vi.fn(), rebindAdb: vi.fn(), state: vi.fn() },
        },
      ],
    });
    permission = TestBed.inject(TvAdbPermission);
    fixture = TestBed.createComponent(WakeNotice);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('draws nothing when the agent has nothing to warn about', () => {
    expect(notice()).toBeNull();
  });

  it('tells where to turn the Screenless service back on, in one short line', () => {
    withHints(['screenless_off']);
    expect(notice()?.getAttribute('role')).toBe('status');
    expect(text()).toBe(
      'Para ligar a TV pelo celular, ative nela: Configurações > Sistema > Energia > Screenless service.',
    );
  });

  it('suggests unplugging only when waking over the network failed, and that comes first', () => {
    withHints(['screenless_off', 'replug']);
    expect(text()).toBe('A TV não ligou pela rede. Tire da tomada e ligue de novo.');
  });

  it('"Ok" hides the warning and the next one shows', () => {
    withHints(['screenless_off', 'replug']);
    notice()!.querySelector<HTMLButtonElement>('button')!.click();
    fixture.detectChanges();
    expect(text()).toContain('Screenless service');
    notice()!.querySelector<HTMLButtonElement>('button')!.click();
    fixture.detectChanges();
    expect(notice()).toBeNull();
  });

  it('says nothing with the agent away (an old reading is not what the TV says now)', () => {
    withHints(['screenless_off'], false);
    expect(notice()).toBeNull();
  });

  it('gives way to the ADB permission sheet, which uses the same spot', () => {
    withHints(['screenless_off']);
    permission.attach();
    permission.denied();
    fixture.detectChanges();
    expect(notice()).toBeNull();
    permission.detach();
  });
});
