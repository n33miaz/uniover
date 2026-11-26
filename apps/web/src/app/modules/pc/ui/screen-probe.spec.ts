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

const MONITORS = JSON.stringify({
  k: 's.mon',
  monitors: [{ id: 0, width: 1920, height: 1080, primary: true, x: 0, y: 0 }],
  layout: 123,
});
const CHUNK_BYTES = 16 * 1024;

function framePacket(sequence: number, jpegWidth = 1280): ArrayBuffer {
  const packet = new Uint8Array(CHUNK_BYTES + 32);
  const view = new DataView(packet.buffer);
  view.setUint32(0, 0x554f5346);
  view.setUint8(4, 1);
  view.setUint16(6, 1280);
  view.setUint16(8, 720);
  view.setUint16(10, sequence);
  view.setUint32(12, packet.length - 16);
  // SOI e APP0 levam o SOF a cruzar o limite de um fragmento.
  packet.set([0xff, 0xd8, 0xff, 0xe0], 16);
  view.setUint16(20, CHUNK_BYTES - 26);
  packet.set(
    [0xff, 0xc0, 0, 11, 8, 2, 208, jpegWidth >> 8, jpegWidth & 0xff, 1, 1, 0x11, 0],
    CHUNK_BYTES - 6,
  );
  return packet.buffer;
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
    expect(peer.channel.send).toHaveBeenLastCalledWith(
      JSON.stringify({ k: 'auth', token: 'autorizacao-tela' }),
    );
    peer.channel.receive(MONITORS);
    expect(peer.channel.binaryType).toBe('arraybuffer');
    expect(peer.channel.send).toHaveBeenLastCalledWith(
      JSON.stringify({ k: 's.get', width: 1280, fps: 8, marker: 1, reset: true }),
    );
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      const packet = framePacket(elapsed / 5_000 + 1);
      peer.channel.receive(
        JSON.stringify({ k: 's.stat', bytes: packet.byteLength, cpu: null, privateMB: 63 }),
      );
      peer.channel.receive(packet.slice(0, CHUNK_BYTES));
      peer.channel.receive('{"k":"s.cur","x":10,"y":20}');
      peer.channel.receive(packet.slice(CHUNK_BYTES));
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
    expect(root.textContent).toContain('O marcador identifica o quadro pedido pelo toque.');
    expect(copyButton).toBeDefined();
    copyButton?.click();
    expect(copy).toHaveBeenCalledWith(expect.stringContaining('| Duração | 60 s | 60 s |'));
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| Toque até o quadro marcado, p50 |'),
    );
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| Toque até o quadro marcado, p95 |'),
    );
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| RTT do ponteiro, p95 | 10 ms (n=60) |'),
    );
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| JPEG binário e ponteiro ativos por 60 s | Sim | Sim |'),
    );
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| CPU média do processo de tela | —%'),
    );
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('| Pico de memória privada do processo de tela | 63 MB'),
    );
  });

  it.each([
    { jpegWidth: 1281, omitHeader: false },
    { jpegWidth: 1280, omitHeader: true },
  ])(
    'recusa quadro antes de decodificar se o SOF ou a contagem de bytes divergir (%j)',
    async ({ jpegWidth, omitHeader }) => {
      const { fixture, root, peer, open } = setup();
      const decode = vi.fn();
      vi.stubGlobal('createImageBitmap', decode);
      await open();
      peer.channel.receive(MONITORS);
      const packet = framePacket(1, jpegWidth);
      const bytes = packet.byteLength - (omitHeader ? 16 : 0);
      peer.channel.receive(JSON.stringify({ k: 's.stat', bytes, cpu: 19, privateMB: 63 }));
      peer.channel.receive(packet.slice(0, CHUNK_BYTES));
      peer.channel.receive(packet.slice(CHUNK_BYTES));
      fixture.detectChanges();
      expect(decode).not.toHaveBeenCalled();
      expect(root.textContent).toContain('Não foi possível medir a tela.');
    },
  );
});
