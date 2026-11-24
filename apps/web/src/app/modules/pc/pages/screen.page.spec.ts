import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DirectChannel,
  DirectSignaling,
  PC_RTC_FACTORY,
} from '../../../core/direct/direct-channel';
import { PcScreenAccess } from '../data/screen-access';
import { ScreenPage } from './screen.page';

class FakeChannel extends EventTarget {
  readonly send = vi.fn<(message: string) => void>();
  readonly close = vi.fn();
  binaryType = '';

  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

class FakeConnection extends EventTarget {
  readonly iceGatheringState = 'complete';
  readonly close = vi.fn();
  readonly channel = new FakeChannel();
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

/** O que o PC manda assim que a sessão autoriza: o tamanho do monitor. */
const MONITOR = { k: 's.mon', width: 1920, height: 1080 };

/** Um quadro no formato do PC (cabeçalho `UOSF` de 16 bytes e 2 bytes de JPEG). */
function jpegFrame(sequence: number): ArrayBuffer {
  const bytes = new Uint8Array(18);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x554f5346);
  view.setUint8(4, 1);
  view.setUint16(6, 640);
  view.setUint16(8, 360);
  view.setUint16(10, sequence);
  view.setUint32(12, 2);
  return bytes.buffer;
}

async function flush(times = 12): Promise<void> {
  for (let n = 0; n < times; n++) await Promise.resolve();
}

function setup() {
  const allowed = signal(true);
  const parent = signal<string | null>('sessao-pc');
  const peer = new FakeConnection();
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
      { provide: DirectChannel, useValue: { pcSessionId: parent } },
      { provide: DirectSignaling, useValue: signaling },
      { provide: PC_RTC_FACTORY, useValue: () => peer },
      { provide: PcScreenAccess, useValue: { allowed } },
    ],
  });
  const fixture = TestBed.createComponent(ScreenPage);
  fixture.detectChanges();
  const root: HTMLElement = fixture.nativeElement;
  const action = () => root.querySelector<HTMLButtonElement>('button.action')!;
  const requests = () =>
    peer.channel.send.mock.calls
      .map(([text]) => JSON.parse(text) as Record<string, unknown>)
      .filter((message) => message['k'] === 's.get');
  async function open() {
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(MONITOR));
    fixture.detectChanges();
  }
  return { fixture, root, peer, signaling, allowed, parent, action, requests, open };
}

describe('Tela do PC (página)', () => {
  let drawImage: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 640, height: 360, close: vi.fn() })),
    );
    drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage,
    })) as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows only the unavailable note when the screen is not allowed', () => {
    const { allowed, fixture, root } = setup();
    allowed.set(false);
    fixture.detectChanges();
    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).toContain('não está disponível');
  });

  it('opens the screen channel, authenticates and asks for the first frame as soon as the monitor size arrives', async () => {
    const { peer, signaling, requests, open } = setup();
    await open();

    expect(peer.createDataChannel).toHaveBeenCalledWith('screen', { ordered: true });
    expect(signaling.offer).toHaveBeenCalledWith('OFERTA', {
      scopes: ['screen'],
      tvId: null,
      parentSessionId: 'sessao-pc',
    });
    expect(peer.channel.send).toHaveBeenCalledWith(
      JSON.stringify({ k: 'auth', token: 'autorizacao-tela' }),
    );
    expect(requests()).toEqual([{ k: 's.get', width: 1280, fps: 6, marker: 0, reset: true }]);
  });

  it('pulls the next frame only after drawing the previous one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { peer, requests, open } = setup();
    await open();
    vi.advanceTimersByTime(2_000);
    expect(requests()).toHaveLength(1);

    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(250);
    expect(requests()).toHaveLength(2);
    expect(requests()[1]['reset']).toBe(false);
  });

  it('does not ask again while the frame is still being decoded, and asks after drawing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let decoded!: (bitmap: { width: number; height: number; close: () => void }) => void;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise((resolve) => {
            decoded = resolve;
          }),
      ),
    );
    const { peer, requests, open } = setup();
    await open();

    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(5_000);
    expect(requests()).toHaveLength(1);
    expect(drawImage).not.toHaveBeenCalled();

    decoded({ width: 640, height: 360, close: vi.fn() });
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(requests()).toHaveLength(2);
  });

  it('keeps the pending request when the monitor size changes and asks with the new size after the frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { peer, requests, open } = setup();
    await open();
    peer.channel.receive(JSON.stringify({ k: 's.mon', width: 800, height: 600 }));
    vi.advanceTimersByTime(2_000);
    expect(requests().map((r) => r['width'])).toEqual([1280]);

    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(0);
    expect(requests().map((r) => r['width'])).toEqual([1280, 800]);
  });

  it('ends the session when a frame arrives while the previous one is still being decoded', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => new Promise(() => undefined)),
    );
    const { peer, open } = setup();
    await open();
    peer.channel.receive(jpegFrame(1));
    await flush();
    peer.channel.receive(jpegFrame(2));
    expect(peer.close).toHaveBeenCalled();
  });

  it('draws the cursor from s.cur as a share of the monitor', async () => {
    const { fixture, peer, root, open } = setup();
    await open();
    peer.channel.receive('{"k":"s.cur","x":960,"y":270}');
    fixture.detectChanges();
    const cursor = root.querySelector<SVGElement>('.cursor')!;
    expect(cursor.style.left).toBe('50%');
    expect(cursor.style.top).toBe('25%');
  });

  it('shows the locked notice, keeps pulling slowly and clears it with the next frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, requests, open } = setup();
    await open();

    peer.channel.receive('{"k":"s.state","state":"locked"}');
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('PC bloqueado');
    vi.advanceTimersByTime(1_100);
    expect(requests()).toHaveLength(2);

    peer.channel.receive(jpegFrame(1));
    await flush();
    fixture.detectChanges();
    expect(root.querySelector('.notice')).toBeNull();
  });

  it('shows the elevated window notice', async () => {
    const { fixture, peer, root, open } = setup();
    await open();
    peer.channel.receive('{"k":"s.state","state":"elevated"}');
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('administrador');
  });

  it('stops pulling and closes the session when the page is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { peer, signaling, requests, open } = setup();
    await open();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(peer.channel.close).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
    expect(signaling.close).toHaveBeenCalledWith('sessao-tela', true);

    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(5_000);
    expect(requests()).toHaveLength(1);
  });

  it('stops pulling and closes the session when the page is destroyed', async () => {
    const { fixture, peer, signaling, open } = setup();
    await open();
    fixture.destroy();
    expect(peer.close).toHaveBeenCalled();
    expect(signaling.close).toHaveBeenCalledWith('sessao-tela', true);
  });

  it('closes the screen when the permission is lost', async () => {
    const { fixture, allowed, peer, open } = setup();
    await open();
    allowed.set(false);
    fixture.detectChanges();
    expect(peer.close).toHaveBeenCalled();
  });

  it('fails with a message when the PC does not answer in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, root, open } = setup();
    await open();
    vi.advanceTimersByTime(10_500);
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('Não foi possível');
  });
});
