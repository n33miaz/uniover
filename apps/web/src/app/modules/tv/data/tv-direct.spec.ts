import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DirectChannel,
  DirectNotSent,
  PC_RTC_CAPABILITY,
  TV_RTC_CAPABILITY,
  type DirectTvTarget,
} from '../../../core/direct/direct-channel';
import { TvAccess } from './tv-access';
import { TvApi } from './tv-api';
import { TvDirect } from './tv-direct';
import { TvSelection } from './tv-selection';
import type { TvSummary } from './tv-types';

function tvSummary(overrides: Partial<TvSummary> = {}): TvSummary {
  return {
    id: 'tv-1',
    name: 'Sala',
    isDefault: true,
    agentSlug: null,
    kind: 'android',
    online: true,
    capabilities: [PC_RTC_CAPABILITY, TV_RTC_CAPABILITY, 'tv.remote'],
    ...overrides,
  };
}

/** O canal de mentira: guarda o alvo da TV e responde o que o teste mandar. */
function fakeChannel() {
  return {
    targets: [] as (DirectTvTarget | null)[],
    started: [] as string[],
    stopped: [] as string[],
    usable: false,
    listed: true,
    command: vi.fn((): Promise<void> => Promise.resolve()),
    tracked: vi.fn(<T>(call: Promise<T>) => call),
    start(owner: string) {
      this.started.push(owner);
    },
    stop(owner: string) {
      this.stopped.push(owner);
    },
    setTvTarget(target: DirectTvTarget | null) {
      this.targets.push(target);
    },
    canUseTv() {
      return this.usable;
    },
    accepts() {
      return this.listed;
    },
    trackTvCloud<T>(call: Promise<T>) {
      return this.tracked(call);
    },
  };
}

function setup(options: { tv?: TvSummary | null; control?: boolean; tvId?: string | null } = {}) {
  const channel = fakeChannel();
  const selected = signal<TvSummary | null>(options.tv === undefined ? tvSummary() : options.tv);
  const control = signal(options.control ?? true);
  const tvId = signal<string | null>(options.tvId ?? null);
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: DirectChannel, useValue: channel },
      { provide: TvSelection, useValue: { selected, tvId } },
      { provide: TvAccess, useValue: { control } },
    ],
  });
  return {
    direct: TestBed.inject(TvDirect),
    api: TestBed.inject(TvApi),
    http: TestBed.inject(HttpTestingController),
    channel,
    selected,
    control,
    tvId,
  };
}

const flushEffects = () => TestBed.tick();
/** O pedido da nuvem sai depois de o canal dizer que não levou: um instante. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('TvDirect: when the channel may open', () => {
  it('asks the channel to open for the TV once the screen is open and the TV can carry keys over it', () => {
    const { direct, channel } = setup({ tvId: 'tv-9' });
    direct.start();
    direct.setLive(true);
    flushEffects();

    expect(channel.started).toEqual(['tv']);
    expect(channel.targets.at(-1)).toEqual({ tvId: 'tv-9', usable: true, live: true });
  });

  it('keeps the channel closed until the screen opens, and stops asking when it closes', () => {
    const { direct, channel } = setup();
    flushEffects();
    expect(channel.targets.at(-1)).toBeNull();

    direct.start();
    flushEffects();
    expect(channel.targets.at(-1)).toEqual({ tvId: null, usable: true, live: false });

    direct.stop();
    flushEffects();
    expect(channel.stopped).toEqual(['tv']);
    expect(channel.targets.at(-1)).toBeNull();
  });

  it.each<[string, Partial<TvSummary>]>([
    ['the agent does not declare tv.rtc.v1', { capabilities: [PC_RTC_CAPABILITY] }],
    ['the agent does not declare pc.rtc.v1', { capabilities: [TV_RTC_CAPABILITY] }],
    ['the TV list came without capabilities (agent off)', { capabilities: [] }],
  ])('does not ask for the TV scope when %s', (_name, overrides) => {
    const { direct, channel } = setup({ tv: tvSummary(overrides) });
    direct.start();
    flushEffects();

    expect(channel.targets.at(-1)).toBeNull();
  });

  it('does not wait for the list to say the agent is online: that answer is old, and the stream says if the TV is up', () => {
    const { direct, channel } = setup({ tv: tvSummary({ online: false }) });
    direct.start();
    flushEffects();

    expect(channel.targets.at(-1)).toEqual({ tvId: null, usable: true, live: false });
  });

  it('does not ask without the permission to control the TV, and asks when it arrives', () => {
    const { direct, channel, control } = setup({ control: false });
    direct.start();
    flushEffects();
    expect(channel.targets.at(-1)).toBeNull();

    control.set(true);
    flushEffects();
    expect(channel.targets.at(-1)).toEqual({ tvId: null, usable: true, live: false });
  });

  it('does not ask without a TV, and follows the TV the person chooses', () => {
    const { direct, channel, selected, tvId } = setup({ tv: null });
    direct.start();
    flushEffects();
    expect(channel.targets.at(-1)).toBeNull();

    selected.set(tvSummary({ id: 'tv-2' }));
    tvId.set('tv-2');
    flushEffects();
    expect(channel.targets.at(-1)).toEqual({ tvId: 'tv-2', usable: true, live: false });
  });

  it('tells the channel when the session with the TV is open', () => {
    const { direct, channel } = setup();
    direct.start();
    direct.setLive(true);
    flushEffects();
    expect(channel.targets.at(-1)?.live).toBe(true);

    direct.setLive(false);
    flushEffects();
    expect(channel.targets.at(-1)?.live).toBe(false);
  });
});

describe('TvDirect: the command', () => {
  it('goes to the cloud (false) without touching the channel when the channel cannot carry it now', async () => {
    const { direct, channel } = setup();
    channel.usable = false;

    expect(await direct.command('tv.key.v3', { key: 'UP' })).toBe(false);
    expect(channel.command).not.toHaveBeenCalled();
  });

  it('goes to the cloud when the agent did not list the message in the ready of the channel', async () => {
    const { direct, channel } = setup();
    channel.usable = true;
    channel.listed = false;

    expect(await direct.command('tv.text.v1', { text: 'a' })).toBe(false);
    expect(channel.command).not.toHaveBeenCalled();
  });

  it('is done (true) when the agent answers the key', async () => {
    const { direct, channel } = setup();
    channel.usable = true;

    expect(await direct.command('tv.key.v3', { key: 'OK' })).toBe(true);
    expect(channel.command).toHaveBeenCalledWith('tv.key.v3', { key: 'OK' });
  });

  it('goes to the cloud when the channel says nothing left', async () => {
    const { direct, channel } = setup();
    channel.usable = true;
    channel.command.mockRejectedValueOnce(new DirectNotSent());

    expect(await direct.command('tv.key.v3', { key: 'OK' })).toBe(false);
  });

  it('lifts a real failure as the error of the cloud, never resending it by the cloud', async () => {
    const { direct, channel } = setup();
    channel.usable = true;
    channel.command.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));

    await expect(direct.command('tv.key.v3', { key: 'OK' })).rejects.toMatchObject({ status: 504 });
  });
});

describe('TvApi over the direct channel', () => {
  it('sends the key only through the channel when it carries it: no HTTP request', async () => {
    const { api, http, channel } = setup();
    channel.usable = true;

    await api.sendKey('RIGHT');

    expect(channel.command).toHaveBeenCalledWith('tv.key.v3', { key: 'RIGHT' });
    http.expectNone('/api/v1/tv/keys');
  });

  it('falls back to the cloud, counted as in flight, when the channel does not carry the key', async () => {
    const { api, http, channel } = setup();
    channel.usable = false;

    const sending = api.sendKey('RIGHT');
    await settled();
    const request = http.expectOne('/api/v1/tv/keys');
    expect(request.request.body).toEqual({ key: 'RIGHT', direction: null });
    request.flush(null);
    await sending;

    expect(channel.tracked).toHaveBeenCalledTimes(1);
  });

  it('does not resend by the cloud a key the channel sent and did not get answered', async () => {
    const { api, http, channel } = setup();
    channel.usable = true;
    channel.command.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));

    await expect(api.sendKey('OK')).rejects.toMatchObject({ status: 504 });
    http.expectNone('/api/v1/tv/keys');
  });

  it('sends the text through the channel, and by the cloud when it cannot', async () => {
    const { api, http, channel } = setup();
    channel.usable = true;
    await api.sendText('filme');
    expect(channel.command).toHaveBeenCalledWith('tv.text.v1', { text: 'filme' });
    http.expectNone('/api/v1/tv/text');

    channel.usable = false;
    const sending = api.sendText('serie');
    await settled();
    http.expectOne('/api/v1/tv/text').flush(null);
    await sending;
  });

  it('never sends the actions that only exist in the cloud through the channel', async () => {
    const { api, http, channel } = setup();
    channel.usable = true;

    const powering = api.powerOff(true);
    http.expectOne('/api/v1/tv/power/off').flush({ result: 'off' });
    await powering;
    const waking = api.wake();
    http.expectOne('/api/v1/tv/wake').flush(null);
    await waking;

    expect(channel.command).not.toHaveBeenCalled();
  });
});
