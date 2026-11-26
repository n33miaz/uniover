import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DirectChannel,
  DirectSignaling,
  PC_RTC_FACTORY,
} from '../../../core/direct/direct-channel';
import { PcStore } from '../data/pc-store';
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

/** A impressão do arranjo que o PC anuncia no `s.mon` e o toque devolve (`l`). */
const LAYOUT = 0x1234_abcd;
/** O que o PC manda assim que a sessão autoriza: o tamanho do monitor. */
const MONITOR = {
  k: 's.mon',
  monitors: [{ id: 7, width: 1920, height: 1080, primary: true }],
  layout: LAYOUT,
};
const TWO_MONITORS = {
  k: 's.mon',
  monitors: [
    { id: 3, width: 1280, height: 1024, primary: false },
    { id: 7, width: 1920, height: 1080, primary: true },
  ],
  layout: 0x0bad_cafe,
};

/** Um quadro com cabeçalho `UOSF` e SOF de 640 × 360 para o decodificador simulado. */
function jpegFrame(sequence: number, jpegWidth = 640): ArrayBuffer {
  const jpeg = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    1,
    104,
    jpegWidth >> 8,
    jpegWidth & 0xff,
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ];
  const bytes = new Uint8Array(16 + jpeg.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x554f5346);
  view.setUint8(4, 1);
  view.setUint16(6, 640);
  view.setUint16(8, 360);
  view.setUint16(10, sequence);
  view.setUint32(12, jpeg.length);
  bytes.set(jpeg, 16);
  return bytes.buffer;
}

async function flush(times = 12): Promise<void> {
  for (let n = 0; n < times; n++) await Promise.resolve();
}

function setup() {
  const allowed = signal(true);
  const touchOn = signal(false);
  const parent = signal<string | null>('sessao-pc');
  const direct = {
    pcSessionId: parent,
    command: vi.fn<(type: string, body: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    ),
    accepts: vi.fn(() => true),
    sendAbsolute: vi.fn(),
  };
  const store = {
    movePointer: vi.fn(),
    scrollPointer: vi.fn(),
    click: vi.fn(async () => null),
    startDrag: vi.fn(async () => null),
    release: vi.fn(async () => null),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
  };
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
      { provide: DirectChannel, useValue: direct },
      { provide: PcStore, useValue: store },
      { provide: DirectSignaling, useValue: signaling },
      { provide: PC_RTC_FACTORY, useValue: () => peer },
      { provide: PcScreenAccess, useValue: { allowed, touch: touchOn } },
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
  return {
    fixture,
    root,
    peer,
    signaling,
    allowed,
    parent,
    action,
    requests,
    open,
    direct,
    store,
    touchOn,
  };
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
    expect(requests()).toEqual([
      { k: 's.get', monitor: 7, width: 1280, fps: 6, marker: 0, reset: true },
    ]);
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
    peer.channel.receive(
      JSON.stringify({ k: 's.mon', monitors: [{ id: 7, width: 320, height: 600, primary: true }] }),
    );
    vi.advanceTimersByTime(2_000);
    expect(requests().map((r) => r['width'])).toEqual([1280]);

    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(0);
    expect(requests().map((r) => r['width'])).toEqual([1280, 320]);
  });

  it('shows no selector with a single monitor', async () => {
    const { root, open } = setup();
    await open();
    expect(root.querySelector('.monitors')).toBeNull();
  });

  it('lists the monitors in an accessible group, starting on the primary one', async () => {
    const { fixture, peer, root, requests, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(TWO_MONITORS));
    fixture.detectChanges();

    const group = root.querySelector('.monitors')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Monitores');
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Monitor 1', 'Monitor 2']);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(requests()[0]['monitor']).toBe(7);
  });

  it('switching monitor resets the frame, uses that monitor width and keeps a single request in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, requests, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(TWO_MONITORS));
    fixture.detectChanges();

    root.querySelectorAll<HTMLButtonElement>('.monitors button')[0].click();
    fixture.detectChanges();
    vi.advanceTimersByTime(2_000);
    expect(requests()).toHaveLength(1);
    expect(root.querySelectorAll('.monitors button')[0].getAttribute('aria-pressed')).toBe('true');

    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(0);
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toEqual({
      k: 's.get',
      monitor: 3,
      width: 1280,
      fps: 6,
      marker: 0,
      reset: true,
    });
  });

  it('falls back to the primary monitor when the chosen one disappears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, requests, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(TWO_MONITORS));
    fixture.detectChanges();
    root.querySelectorAll<HTMLButtonElement>('.monitors button')[0].click();
    peer.channel.receive(JSON.stringify(MONITOR));
    fixture.detectChanges();
    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(0);
    expect(requests()[requests().length - 1]['monitor']).toBe(7);
    expect(root.querySelector('.monitors')).toBeNull();
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

  it('positions cursor relative to the secondary monitor when selected', async () => {
    const { fixture, peer, root, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(
      JSON.stringify({
        k: 's.mon',
        monitors: [
          { id: 0, width: 1920, height: 1080, primary: true, x: 0, y: 0 },
          { id: 1, width: 1920, height: 1080, primary: false, x: 1920, y: 0 },
        ],
        layout: 0x1234,
      }),
    );
    fixture.detectChanges();
    root.querySelectorAll<HTMLButtonElement>('.monitors button')[1].click();
    fixture.detectChanges();

    peer.channel.receive('{"k":"s.cur","x":2880,"y":540}');
    fixture.detectChanges();

    const cursor = root.querySelector<SVGElement>('.cursor')!;
    expect(cursor).not.toBeNull();
    expect(cursor.style.left).toBe('50%');
    expect(cursor.style.top).toBe('50%');
  });

  it('hides the cursor when it is located outside the selected monitor', async () => {
    const { fixture, peer, root, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(
      JSON.stringify({
        k: 's.mon',
        monitors: [
          { id: 0, width: 1920, height: 1080, primary: true, x: 0, y: 0 },
          { id: 1, width: 1920, height: 1080, primary: false, x: 1920, y: 0 },
        ],
        layout: 0x1234,
      }),
    );
    fixture.detectChanges();
    root.querySelectorAll<HTMLButtonElement>('.monitors button')[1].click();
    fixture.detectChanges();

    peer.channel.receive('{"k":"s.cur","x":960,"y":540}');
    fixture.detectChanges();

    expect(root.querySelector<SVGElement>('.cursor')).toBeNull();

    peer.channel.receive('{"k":"s.cur","x":2400,"y":540}');
    fixture.detectChanges();

    expect(root.querySelector<SVGElement>('.cursor')).not.toBeNull();
  });

  it('calculates cursor position and visibility with negative monitor coordinates', async () => {
    const { fixture, peer, root, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(
      JSON.stringify({
        k: 's.mon',
        monitors: [
          { id: 1, width: 1920, height: 1080, primary: false, x: -1920, y: 0 },
          { id: 0, width: 1920, height: 1080, primary: true, x: 0, y: 0 },
        ],
        layout: 0x5678,
      }),
    );
    fixture.detectChanges();
    root.querySelectorAll<HTMLButtonElement>('.monitors button')[0].click();
    fixture.detectChanges();

    peer.channel.receive('{"k":"s.cur","x":-960,"y":270}');
    fixture.detectChanges();

    const cursor = root.querySelector<SVGElement>('.cursor')!;
    expect(cursor).not.toBeNull();
    expect(cursor.style.left).toBe('50%');
    expect(cursor.style.top).toBe('25%');

    peer.channel.receive('{"k":"s.cur","x":500,"y":500}');
    fixture.detectChanges();

    expect(root.querySelector<SVGElement>('.cursor')).toBeNull();

    root.querySelectorAll<HTMLButtonElement>('.monitors button')[1].click();
    fixture.detectChanges();

    const primaryCursor = root.querySelector<SVGElement>('.cursor')!;
    expect(primaryCursor).not.toBeNull();
    expect(primaryCursor.style.left).toBe(`${(500 / 1920) * 100}%`);
  });

  it('shows the locked notice without touching the pending request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, requests, open } = setup();
    await open();

    peer.channel.receive('{"k":"s.state","state":"locked"}');
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('PC bloqueado');
    // O estado não responde ao pedido: nenhum segundo `s.get` sai com o primeiro ainda em andamento.
    vi.advanceTimersByTime(1_100);
    expect(requests()).toHaveLength(1);

    peer.channel.receive(jpegFrame(1));
    await flush();
    fixture.detectChanges();
    expect(root.querySelector('.notice')).toBeNull();
    vi.advanceTimersByTime(250);
    expect(requests()).toHaveLength(2);
  });

  it('keeps "PC bloqueado" as a stable notice, not a failure, when the PC closes the session after locking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, action, open } = setup();
    await open();

    peer.channel.receive('{"k":"s.state","state":"locked"}');
    peer.channel.dispatchEvent(new Event('close'));
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('PC bloqueado');
    expect(root.textContent).not.toContain('Não foi possível');
    expect(action().textContent).toContain('Ver a tela');

    vi.advanceTimersByTime(30_000);
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('PC bloqueado');
  });

  it('still fails when the session closes without a locked state', async () => {
    const { fixture, peer, root, open } = setup();
    await open();
    peer.channel.dispatchEvent(new Event('close'));
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('Não foi possível');
  });

  it('treats the pending request as lost when the monitor in use disappears from s.mon', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, requests, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(TWO_MONITORS));
    fixture.detectChanges();
    expect(requests().map((r) => r['monitor'])).toEqual([7]);

    // O monitor 7 sumiu: o PC descarta o pedido sem responder e o cliente não espera por ele.
    peer.channel.receive(
      JSON.stringify({
        k: 's.mon',
        monitors: [{ id: 3, width: 1280, height: 1024, primary: true }],
      }),
    );
    expect(requests().map((r) => r['monitor'])).toEqual([7, 3]);
    expect(requests()[1]['reset']).toBe(true);

    peer.channel.receive(jpegFrame(1));
    await flush();
    fixture.detectChanges();
    vi.advanceTimersByTime(9_000);
    expect(requests().length).toBeGreaterThanOrEqual(2);
    expect(peer.close).not.toHaveBeenCalled();
  });

  it('reopens the screen session by itself before the 90 s limit, without showing a failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, signaling, open } = setup();
    await open();
    expect(signaling.offer).toHaveBeenCalledTimes(1);

    // O PC vai respondendo (senão o aviso de 10 s sem resposta encerraria antes); aos 75 s a página renova.
    for (let second = 0; second < 74; second++) {
      vi.advanceTimersByTime(1_000);
      peer.channel.receive(jpegFrame(second));
      await flush();
    }
    expect(signaling.offer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await flush(60);
    fixture.detectChanges();
    expect(signaling.close).toHaveBeenCalledWith('sessao-tela', true);
    expect(signaling.offer).toHaveBeenCalledTimes(2);
    expect(root.textContent).not.toContain('Não foi possível');

    peer.channel.receive(JSON.stringify(MONITOR));
    fixture.detectChanges();
    expect(root.querySelector('.notice')).toBeNull();
  });

  it('counts the 75 s renewal from the accepted offer, not from the first s.mon', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { peer, signaling, action } = setup();
    action().click();
    await flush();
    // O primeiro s.mon demora 18 s (dentro dos 20 s de espera inicial).
    vi.advanceTimersByTime(18_000);
    peer.channel.receive(JSON.stringify(MONITOR));
    for (let second = 18; second < 74; second++) {
      vi.advanceTimersByTime(1_000);
      peer.channel.receive(jpegFrame(second));
      await flush();
    }
    expect(signaling.offer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await flush(60);
    expect(signaling.close).toHaveBeenCalledWith('sessao-tela', true);
    expect(signaling.offer).toHaveBeenCalledTimes(2);
  });

  it('judges a lost request by the requested monitor, not the selected one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, requests, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(TWO_MONITORS));
    fixture.detectChanges();
    expect(requests().map((r) => r['monitor'])).toEqual([7]);

    // Pedido pendente do monitor 7; o usuário escolhe o 3, que some: o pedido do 7 continua valendo.
    root.querySelectorAll<HTMLButtonElement>('.monitors button')[0].click();
    peer.channel.receive(
      JSON.stringify({
        k: 's.mon',
        monitors: [{ id: 7, width: 1920, height: 1080, primary: true }],
      }),
    );
    expect(requests()).toHaveLength(1);
    peer.channel.receive(jpegFrame(1));
    await flush();
    vi.advanceTimersByTime(0);
    expect(requests().map((r) => r['monitor'])).toEqual([7, 7]);
  });

  it('drops the pending request when the requested monitor disappears even if another is selected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, root, requests, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(TWO_MONITORS));
    fixture.detectChanges();

    // Pedido pendente do monitor 7; o usuário escolhe o 3 e o 7 some: o PC descartou o pedido, que é dado como perdido.
    root.querySelectorAll<HTMLButtonElement>('.monitors button')[0].click();
    peer.channel.receive(
      JSON.stringify({
        k: 's.mon',
        monitors: [{ id: 3, width: 1280, height: 1024, primary: true }],
      }),
    );
    expect(requests().map((r) => r['monitor'])).toEqual([7, 3]);
    expect(requests()[1]['reset']).toBe(true);
  });

  it('does not reopen after the user stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, signaling, action, open } = setup();
    await open();
    action().click();
    fixture.detectChanges();
    vi.advanceTimersByTime(120_000);
    await flush();
    expect(signaling.offer).toHaveBeenCalledTimes(1);
  });

  it('refuses an image whose size differs from the frame header', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 8000, height: 6000, close: vi.fn() })),
    );
    const { fixture, peer, root, open } = setup();
    await open();
    peer.channel.receive(jpegFrame(1));
    await flush();
    fixture.detectChanges();
    expect(drawImage).not.toHaveBeenCalled();
    expect(root.querySelector('.notice')?.textContent).toContain('Não foi possível');
  });

  it('recusa dimensões divergentes no SOF antes de chamar o decodificador', async () => {
    const { fixture, peer, root, open } = setup();
    await open();
    peer.channel.receive(jpegFrame(1, 641));
    await flush();
    fixture.detectChanges();
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(root.querySelector('.notice')?.textContent).toContain('Não foi possível');
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

  describe('touch on the image', () => {
    /** Dá ao quadro o tamanho de 400 x 225 na tela (o jsdom não mede nada) e devolve o disparo de dedos. */
    function stageOf(root: HTMLElement) {
      const stage = root.querySelector<HTMLElement>('.stage')!;
      const size = (width: number, height: number) => {
        Object.defineProperty(stage, 'clientWidth', { value: width, configurable: true });
        Object.defineProperty(stage, 'clientHeight', { value: height, configurable: true });
      };
      size(400, 225);
      stage.getBoundingClientRect = () => ({ left: 10, top: 20 }) as DOMRect;
      const fire = (type: string, x: number, y: number, pointer = 1) => {
        const event = new MouseEvent(type, { clientX: 10 + x, clientY: 20 + y, bubbles: true });
        Object.defineProperty(event, 'pointerId', { value: pointer });
        stage.dispatchEvent(event);
      };
      return { stage, fire, size };
    }

    async function touching() {
      const kit = setup();
      kit.touchOn.set(true);
      await kit.open();
      // O primeiro quadro desenhado é o que mostra a imagem (e a barra de toque).
      kit.peer.channel.receive(jpegFrame(1));
      await flush();
      kit.fixture.detectChanges();
      return { ...kit, ...stageOf(kit.root) };
    }

    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));

    it('a tap sends one tap at the point, relative to the monitor and with the size the app saw', async () => {
      const { fire, direct } = await touching();
      fire('pointerdown', 200, 112.5);
      fire('pointerup', 200, 112.5);
      expect(direct.command).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(direct.command).toHaveBeenCalledOnce();
      expect(direct.command).toHaveBeenCalledWith('pc.tap.v1', {
        m: 7,
        l: LAYOUT,
        u: 32768,
        v: 32768,
        w: 1920,
        h: 1080,
        button: 'LEFT',
        action: 'CLICK',
      });
    });

    it('does nothing when the PC does not declare the touch (the screen is only for viewing)', async () => {
      const kit = setup();
      await kit.open();
      kit.peer.channel.receive(jpegFrame(1));
      await flush();
      kit.fixture.detectChanges();
      const { fire } = stageOf(kit.root);
      fire('pointerdown', 20, 20);
      fire('pointerup', 20, 20);
      vi.advanceTimersByTime(400);
      expect(kit.direct.command).not.toHaveBeenCalled();
      expect(kit.root.querySelector('.tools')).toBeNull();
    });

    it('does not send the tap to an agent whose channel did not list it', async () => {
      const { fire, direct, fixture, root } = await touching();
      direct.accepts.mockReturnValue(false);
      fire('pointerdown', 20, 20);
      fire('pointerup', 20, 20);
      vi.advanceTimersByTime(400);
      fixture.detectChanges();
      expect(direct.command).not.toHaveBeenCalled();
      expect(root.querySelector('.notice')?.textContent).toContain('canal direto');
    });

    it('a changed monitor layout is told to the person, who waits for the new image', async () => {
      const { fire, direct, fixture, root } = await touching();
      direct.command.mockRejectedValueOnce(
        new HttpErrorResponse({ status: 502, error: { agentError: 'stale_layout' } }),
      );
      fire('pointerdown', 20, 20);
      fire('pointerup', 20, 20);
      vi.advanceTimersByTime(400);
      await flush();
      fixture.detectChanges();
      expect(root.querySelector('.notice')?.textContent).toContain('monitores do PC mudaram');
    });

    it('an administrator window says why the click did not happen', async () => {
      const { fire, direct, fixture, root } = await touching();
      direct.command.mockRejectedValueOnce(
        new HttpErrorResponse({ status: 502, error: { agentError: 'elevated_window' } }),
      );
      fire('pointerdown', 20, 20);
      fire('pointerup', 20, 20);
      vi.advanceTimersByTime(400);
      await flush();
      fixture.detectChanges();
      expect(root.querySelector('.notice')?.textContent).toContain('janela de administrador');
    });

    it('a drag sends DOWN, absolute positions and UP, and the UP goes even if the page closes in the middle', async () => {
      const { fire, direct, fixture } = await touching();
      fire('pointerdown', 100, 100);
      fire('pointerup', 100, 100);
      vi.advanceTimersByTime(50);
      fire('pointerdown', 100, 100);
      vi.advanceTimersByTime(250);
      fire('pointermove', 200, 150);
      expect(direct.command).toHaveBeenCalledWith(
        'pc.tap.v1',
        expect.objectContaining({ action: 'DOWN', button: 'LEFT' }),
      );
      expect(direct.sendAbsolute).toHaveBeenLastCalledWith({
        m: 7,
        l: LAYOUT,
        u: 32768,
        v: 43690,
        w: 1920,
        h: 1080,
      });
      fixture.destroy();
      expect(direct.command).toHaveBeenLastCalledWith(
        'pc.tap.v1',
        expect.objectContaining({ action: 'UP', button: 'LEFT' }),
      );
    });

    it('a layout change drops the tap that was waiting for its second touch', async () => {
      const { fire, direct, peer } = await touching();
      fire('pointerdown', 100, 100);
      fire('pointerup', 100, 100);
      peer.channel.receive(
        JSON.stringify({
          k: 's.mon',
          monitors: [{ id: 7, width: 800, height: 600, primary: true }],
        }),
      );
      vi.advanceTimersByTime(1000);
      expect(direct.command).not.toHaveBeenCalled();
    });

    it('after switching monitor the old image takes no tap, not even when a late frame of the old monitor arrives', async () => {
      const kit = setup();
      kit.touchOn.set(true);
      kit.action().click();
      await flush();
      kit.peer.channel.receive(JSON.stringify(TWO_MONITORS));
      kit.fixture.detectChanges();
      kit.peer.channel.receive(jpegFrame(1));
      await flush();
      kit.fixture.detectChanges();
      const { fire } = stageOf(kit.root);
      // O pedido seguinte (do monitor 7) sai e fica em andamento.
      vi.advanceTimersByTime(200);
      expect(kit.requests().at(-1)?.['monitor']).toBe(7);
      kit.root.querySelectorAll<HTMLButtonElement>('.monitors button')[0].click();
      kit.fixture.detectChanges();
      const tap = () => {
        fire('pointerdown', 200, 112.5);
        fire('pointerup', 200, 112.5);
        vi.advanceTimersByTime(400);
      };
      // A imagem na tela ainda é a do monitor 7: o toque nela não sai.
      tap();
      expect(kit.direct.command).not.toHaveBeenCalled();
      // Chega o quadro do pedido antigo (monitor 7): continua sem toque.
      kit.peer.channel.receive(jpegFrame(2));
      await flush();
      tap();
      expect(kit.direct.command).not.toHaveBeenCalled();
      // O pedido do monitor 3 sai e o quadro dele é pintado: agora o toque vai, com o monitor e o tamanho dele.
      vi.advanceTimersByTime(0);
      expect(kit.requests().at(-1)?.['monitor']).toBe(3);
      kit.peer.channel.receive(jpegFrame(3));
      await flush();
      tap();
      expect(kit.direct.command).toHaveBeenCalledExactlyOnceWith('pc.tap.v1', {
        m: 3,
        l: 0x0bad_cafe,
        u: 32768,
        v: 32768,
        w: 1280,
        h: 1024,
        button: 'LEFT',
        action: 'CLICK',
      });
    });

    it('a new arrangement with the same monitor number and size takes no tap until its own frame is drawn', async () => {
      const { fire, direct, peer } = await touching();
      // Dois monitores iguais, o primeiro desligado: o mesmo número e tamanho, outra impressão.
      peer.channel.receive(JSON.stringify({ ...MONITOR, layout: LAYOUT + 1 }));
      fire('pointerdown', 200, 112.5);
      fire('pointerup', 200, 112.5);
      vi.advanceTimersByTime(400);
      expect(direct.command).not.toHaveBeenCalled();
      peer.channel.receive(jpegFrame(2));
      await flush();
      vi.advanceTimersByTime(0);
      peer.channel.receive(jpegFrame(3));
      await flush();
      fire('pointerdown', 200, 112.5);
      fire('pointerup', 200, 112.5);
      vi.advanceTimersByTime(400);
      expect(direct.command).toHaveBeenCalledWith(
        'pc.tap.v1',
        expect.objectContaining({ m: 7, l: LAYOUT + 1 }),
      );
    });

    it('an older PC without the layout print never gets a tap on the image', async () => {
      const kit = setup();
      kit.touchOn.set(true);
      kit.action().click();
      await flush();
      kit.peer.channel.receive(JSON.stringify({ k: 's.mon', monitors: MONITOR.monitors }));
      kit.fixture.detectChanges();
      kit.peer.channel.receive(jpegFrame(1));
      await flush();
      kit.fixture.detectChanges();
      const { fire } = stageOf(kit.root);
      fire('pointerdown', 200, 112.5);
      fire('pointerup', 200, 112.5);
      vi.advanceTimersByTime(400);
      expect(kit.direct.command).not.toHaveBeenCalled();
    });

    it('a stage resize applies the clamped zoom at once, and the touch after it maps with the transform on screen', async () => {
      let resized: (() => void) | undefined;
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resized = callback;
          }
          readonly observe = vi.fn();
          readonly disconnect = vi.fn();
        },
      );
      const { fire, direct, fixture, root, size } = await touching();
      const view = () => root.querySelector<HTMLElement>('.view')!.style.transform;
      // Pinça abrindo perto do canto de baixo à direita: 2x, e a imagem desliza até o limite (-400, -225).
      fire('pointerdown', 300, 200, 1);
      fire('pointerdown', 400, 200, 2);
      fire('pointermove', 200, 200, 1);
      fire('pointerup', 200, 200, 1);
      fire('pointerup', 400, 200, 2);
      fixture.detectChanges();
      const before = view();
      expect(before).toContain('scale(');
      // O palco encolhe (o aparelho girou): o observador ajusta o deslocamento e a imagem na tela muda já.
      size(200, 112.5);
      resized?.();
      fixture.detectChanges();
      expect(view()).not.toBe(before);
      // O toque seguinte usa a transformação que está na tela.
      vi.advanceTimersByTime(1000);
      direct.command.mockClear();
      fire('pointerdown', 100, 56.25);
      fire('pointerup', 100, 56.25);
      vi.advanceTimersByTime(400);
      expect(direct.command).toHaveBeenCalledOnce();
      const sent = direct.command.mock.calls[0][1] as { u: number; v: number };
      // O que a pessoa vê sob o dedo: o ponto da imagem pela transformação aplicada ao elemento.
      const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(view())!;
      const [panX, panY, scale] = match.slice(1).map(Number);
      expect(sent.u).toBe(Math.round(Math.min(1, Math.max(0, (100 - panX) / scale / 200)) * 65535));
      expect(sent.v).toBe(
        Math.round(Math.min(1, Math.max(0, (56.25 - panY) / scale / 112.5)) * 65535),
      );
    });

    it('in touchpad mode the finger moves the pointer by steps and never sends a tap on the image', async () => {
      const { fire, direct, store, fixture, root } = await touching();
      root.querySelector<HTMLButtonElement>('.tools button')!.click();
      fixture.detectChanges();
      fire('pointerdown', 100, 100);
      fire('pointermove', 140, 100);
      fire('pointerup', 140, 100);
      expect(store.movePointer).toHaveBeenCalled();
      expect(store.beginGesture).toHaveBeenCalledOnce();
      expect(store.endGesture).toHaveBeenCalledOnce();
      expect(direct.command).not.toHaveBeenCalled();
      expect(direct.sendAbsolute).not.toHaveBeenCalled();
    });

    it('the mode button says which mode is on, in Portuguese', async () => {
      const { fixture, root } = await touching();
      const button = root.querySelector<HTMLButtonElement>('.tools button')!;
      expect(button.textContent).toContain('Toque direto');
      button.click();
      fixture.detectChanges();
      expect(root.querySelector('.tools button')!.textContent).toContain('Touchpad');
    });
  });
});
