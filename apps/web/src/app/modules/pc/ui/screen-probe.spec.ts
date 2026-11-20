import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import {
  DirectChannel,
  DirectSignaling,
  PC_RTC_FACTORY,
} from '../../../core/direct/direct-channel';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { PcScreenProbe } from './screen-probe';

class FakeScreenChannel extends EventTarget {
  readonly send = vi.fn<(message: string) => void>();
  readonly close = vi.fn();
  binaryType = '';

  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

class FakeScreenConnection extends EventTarget {
  readonly iceGatheringState = 'complete';
  readonly close = vi.fn();
  readonly channel = new FakeScreenChannel();
  readonly createDataChannel = vi.fn(() => this.channel);
  localDescription: RTCSessionDescriptionInit | null = null;

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'OFERTA' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(): Promise<void> {
    this.channel.dispatchEvent(new Event('open'));
  }
}

function setup(role = signal<'owner' | 'guest'>('owner')) {
  const session = signal<string | null>('sessao-ponteiro');
  const pongs = new Subject<{ sessionId: string; milliseconds: number }>();
  const peer = new FakeScreenConnection();
  const factory = vi.fn(() => peer);
  const signaling = {
    offer: vi.fn(async () => ({
      sessionId: 'sessao-tela',
      sdp: 'RESPOSTA',
      token: 'autorizacao-tela',
      scopes: ['screen'],
    })),
    close: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DirectChannel,
        useValue: { pcSessionId: session, pointerRtt: pongs.asObservable() },
      },
      { provide: DirectSignaling, useValue: signaling },
      { provide: PC_RTC_FACTORY, useValue: factory },
      { provide: PcAvailability, useValue: { capabilities: () => ['pc.screen.v1'] } },
      { provide: SessionState, useValue: { isAuthenticated: () => true, role } },
    ],
  });

  const fixture = TestBed.createComponent(PcScreenProbe);
  fixture.detectChanges();
  const root: HTMLElement = fixture.nativeElement;
  const measure = () => root.querySelector<HTMLButtonElement>('button')!;
  async function open() {
    measure().click();
    for (let microtask = 0; microtask < 8; microtask++) await Promise.resolve();
  }
  return { fixture, root, peer, factory, signaling, session, pongs, measure, open };
}

describe('Medição da tela do PC', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('abre outro par via sinalização existente só com ação do dono', async () => {
    const role = signal<'owner' | 'guest'>('guest');
    const { fixture, factory, signaling, peer, measure, open } = setup(role);

    expect(measure().disabled).toBe(true);
    await open();
    expect(factory).not.toHaveBeenCalled();
    role.set('owner');
    fixture.detectChanges();
    expect(measure().disabled).toBe(false);
    await open();

    expect(peer.createDataChannel).toHaveBeenCalledWith('screen', { ordered: true });
    expect(signaling.offer).toHaveBeenCalledWith('OFERTA', {
      scopes: ['screen'],
      tvId: null,
      parentSessionId: 'sessao-ponteiro',
    });
    expect(peer.channel.send).toHaveBeenCalledWith(
      JSON.stringify({ k: 'auth', token: 'autorizacao-tela' }),
    );

    document.defaultView?.dispatchEvent(new Event('pagehide'));
    expect(peer.close).toHaveBeenCalledOnce();
    expect(signaling.close).toHaveBeenCalledExactlyOnceWith('sessao-tela', true);
  });

  it('decodifica um JPEG binário, conta só pongs da sessão e fecha após 60 s', async () => {
    const { fixture, root, peer, signaling, pongs, open } = setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const decode = vi.fn(async () => ({ width: 1280, height: 720, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 1),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(128 * 4) }),
    } as unknown as CanvasRenderingContext2D);
    const copy = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } });

    await open();
    peer.channel.receive(JSON.stringify({ k: 'ready' }));
    expect(peer.channel.binaryType).toBe('arraybuffer');
    expect(peer.channel.send).toHaveBeenLastCalledWith(
      JSON.stringify({ k: 's.get', width: 1280, fps: 8, marker: 0, reset: true }),
    );
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      peer.channel.receive(JSON.stringify({ bytes: 7, cpu: 19, privateMB: 63 }));
      peer.channel.receive(new ArrayBuffer(3));
      peer.channel.receive(new ArrayBuffer(4));
      await vi.advanceTimersByTimeAsync(5);
      pongs.next({ sessionId: 'outro-ponteiro', milliseconds: 80 });
      pongs.next({ sessionId: 'sessao-ponteiro', milliseconds: 10 });
      await vi.advanceTimersByTimeAsync(995);
      for (let second = 1; second < 5; second++) {
        pongs.next({ sessionId: 'sessao-ponteiro', milliseconds: 10 });
        await vi.advanceTimersByTimeAsync(1_000);
      }
    }

    expect(decode).toHaveBeenCalledTimes(12);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(signaling.close).toHaveBeenCalledExactlyOnceWith('sessao-tela', true);
    fixture.detectChanges();
    const copyButton = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Copiar resultados',
    );
    expect(copyButton).toBeDefined();
    copyButton?.click();
    expect(copy).toHaveBeenCalledWith(expect.stringContaining('| Duração | 60 s | 60 s |'));
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| RTT do ponteiro, p95 | 10 ms (n=60) |'),
    );
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| JPEG binário e ponteiro ativos por 60 s | Sim | Sim |'),
    );
  });
});
