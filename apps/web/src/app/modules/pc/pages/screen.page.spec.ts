import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DirectChannel,
  DirectSignaling,
  PC_RTC_FACTORY,
} from '../../../core/direct/direct-channel';
import { AccountScope } from '../../../core/session/account-scope';
import { PcStore } from '../data/pc-store';
import { PcScreenAccess } from '../data/screen-access';
import { createFakePcStore } from '../pc-test-kit';
import { SENTINEL } from '../ui/live-keyboard';
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
function jpegFrame(
  sequence: number,
  {
    width = 640,
    height = 360,
    jpegWidth = width,
  }: {
    width?: number;
    height?: number;
    jpegWidth?: number;
  } = {},
): ArrayBuffer {
  const jpeg = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 0xff,
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
  view.setUint16(6, width);
  view.setUint16(8, height);
  view.setUint16(10, sequence);
  view.setUint32(12, jpeg.length);
  bytes.set(jpeg, 16);
  return bytes.buffer;
}

async function flush(times = 12): Promise<void> {
  for (let n = 0; n < times; n++) await Promise.resolve();
}

function setup({ authorized = true, screenAvailable = true } = {}) {
  const allowed = signal(authorized && screenAvailable);
  const accountCanView = signal(authorized);
  const accountId = signal<string | null>('conta-1');
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
  // O dublê completo: o teclado ao vivo da página usa a mesma fila de entrada do Mouse.
  const store = createFakePcStore();
  const peer = new FakeConnection();
  const createPeer = vi.fn(() => peer);
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
      { provide: PC_RTC_FACTORY, useValue: createPeer },
      { provide: AccountScope, useValue: { id: accountId } },
      { provide: PcScreenAccess, useValue: { allowed, accountCanView, touch: touchOn } },
    ],
  });
  const fixture = TestBed.createComponent(ScreenPage);
  fixture.detectChanges();
  const root: HTMLElement = fixture.nativeElement;
  const action = () => root.querySelector<HTMLButtonElement>('button.action')!;
  const requests = (connection = peer) =>
    connection.channel.send.mock.calls
      .map(([text]) => JSON.parse(text) as Record<string, unknown>)
      .filter((message) => message['k'] === 's.get');
  async function open(announcement = MONITOR) {
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(announcement));
    fixture.detectChanges();
  }
  return {
    fixture,
    root,
    peer,
    createPeer,
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
    localStorage.removeItem('uniover.quick-tour.conta-1.pc-screen');
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

  it('explains that an account without the permission cannot view the screen', () => {
    const { root } = setup({ authorized: false });
    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).toContain('não foi liberada para esta conta');
    expect(localStorage.getItem('uniover.quick-tour.conta-1.pc-screen')).toBeNull();
  });

  it('does not suggest an approval when the PC lacks screen support', () => {
    const { root } = setup({ screenAvailable: false });
    expect(root.textContent).toContain('não está disponível');
    expect(root.textContent).not.toContain('permissão pendente');
    expect(root.querySelector('button')).toBeNull();
  });

  it('explains a pending device approval while waiting for the direct channel', () => {
    const { store, parent, action, fixture, root } = setup();
    parent.set(null);
    store.notice.set({ kind: 'device-pending', message: '' });
    fixture.detectChanges();
    expect(root.querySelector('.note')?.textContent).toContain('aprove este aparelho no PC');
    expect(action().disabled).toBe(true);
    store.notice.set(null);
    fixture.detectChanges();
    expect(root.querySelector('.note')?.textContent).toContain('Aguardando o canal direto');
  });

  it('opens the screen tour on a first visit and reopens it from the temporary information button', () => {
    const { fixture, root } = setup();
    expect(root.querySelector('app-quick-tour .tour')?.textContent).toContain('Ver a tela');

    const info = root.querySelector<HTMLButtonElement>('app-quick-tour .info')!;
    info.click();
    fixture.detectChanges();
    expect(root.querySelector('app-quick-tour .tour')).toBeNull();

    info.click();
    fixture.detectChanges();
    expect(root.querySelector('app-quick-tour .tour')?.textContent).toContain('Ver a tela');

    fixture.destroy();
    const returning = TestBed.createComponent(ScreenPage);
    returning.detectChanges();
    const returningRoot: HTMLElement = returning.nativeElement;
    expect(returningRoot.querySelector('app-quick-tour .tour')).toBeNull();
    const returningInfo = returningRoot.querySelector<HTMLButtonElement>('app-quick-tour .info');
    expect(returningInfo).toBeTruthy();
    returningInfo!.click();
    returning.detectChanges();
    expect(returningRoot.querySelector('app-quick-tour .tour')?.textContent).toContain(
      'Ver a tela',
    );
  });

  it('hides the information button after 30 days and keeps the screen available', () => {
    const firstVisit = Date.now() - 30 * 24 * 60 * 60 * 1000;
    localStorage.setItem('uniover.quick-tour.conta-1.pc-screen', String(firstVisit));
    const { root, action } = setup();
    expect(root.querySelector('app-quick-tour button')).toBeNull();
    expect(action().disabled).toBe(false);
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

  it.each([
    { width: 1080, height: 1920, frameWidth: 1080, frameHeight: 1920 },
    { width: 1920, height: 1200, frameWidth: 1280, frameHeight: 800 },
    { width: 320, height: 600, frameWidth: 320, frameHeight: 600 },
  ])(
    'draws the pending frame after the monitor changes to $width × $height',
    async ({ width, height, frameWidth, frameHeight }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const bitmap = { width: frameWidth, height: frameHeight, close: vi.fn() };
      vi.mocked(createImageBitmap).mockResolvedValue(bitmap as ImageBitmap);
      const { peer, requests, open } = setup();
      await open();
      peer.channel.receive(
        JSON.stringify({
          ...MONITOR,
          layout: LAYOUT + 1,
          monitors: [{ ...MONITOR.monitors[0], width, height }],
        }),
      );
      vi.advanceTimersByTime(2_000);
      expect(requests().map((r) => r['width'])).toEqual([1280]);

      peer.channel.receive(jpegFrame(1, { width: frameWidth, height: frameHeight }));
      await flush();

      expect(createImageBitmap).toHaveBeenCalledTimes(1);
      expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
      expect(peer.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(requests().map((r) => r['width'])).toEqual([1280, frameWidth]);
    },
  );

  it.each([
    { width: 641, height: 400 },
    { width: 640, height: 401 },
  ])('rejects a pending frame of $width × $height after a monitor resize', async (size) => {
    const { fixture, peer, root, requests, open } = setup();
    await open({ ...MONITOR, monitors: [{ ...MONITOR.monitors[0], width: 640, height: 360 }] });
    peer.channel.receive(
      JSON.stringify({
        ...MONITOR,
        layout: LAYOUT + 1,
        monitors: [{ ...MONITOR.monitors[0], height: 1200 }],
      }),
    );
    expect(requests().map((r) => r['width'])).toEqual([640]);

    peer.channel.receive(jpegFrame(1, size));
    await flush();
    fixture.detectChanges();

    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(root.querySelector('.notice')?.textContent).toContain('Não foi possível');
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

  it.each([
    {
      outcome: 'keeps the selected secondary monitor',
      announcement: {
        ...TWO_MONITORS,
        monitors: [TWO_MONITORS.monitors[1], { ...TWO_MONITORS.monitors[0], width: 1024 }],
      },
      expectedMonitor: 3,
      expectedWidth: 1024,
    },
    {
      outcome: 'falls back to the primary monitor when the selected one is gone',
      announcement: {
        ...MONITOR,
        monitors: [{ id: 5, width: 1024, height: 768, primary: false }, ...MONITOR.monitors],
      },
      expectedMonitor: 7,
      expectedWidth: 1280,
    },
  ])('reopens the session before the 90 s limit and $outcome', async (scenario) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, peer, createPeer, root, signaling, action, requests } = setup();
    const renewedPeer = new FakeConnection();
    createPeer.mockReturnValueOnce(peer).mockReturnValueOnce(renewedPeer);
    action().click();
    await flush();
    peer.channel.receive(JSON.stringify(TWO_MONITORS));
    fixture.detectChanges();
    root.querySelectorAll<HTMLButtonElement>('.monitors button')[0].click();

    // O PC responde aos pedidos até a renovação automática aos 75 s.
    for (let second = 0; second < 74; second++) {
      vi.advanceTimersByTime(1_000);
      peer.channel.receive(jpegFrame(second));
      await flush();
    }
    expect(requests().at(-1)?.['monitor']).toBe(3);
    expect(signaling.offer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await flush(60);
    fixture.detectChanges();
    expect(signaling.close).toHaveBeenCalledWith('sessao-tela', true);
    expect(signaling.offer).toHaveBeenCalledTimes(2);
    expect(root.textContent).not.toContain('Não foi possível');
    expect(requests(renewedPeer)).toHaveLength(0);

    renewedPeer.channel.receive(JSON.stringify(scenario.announcement));
    fixture.detectChanges();
    expect(requests(renewedPeer)).toEqual([
      expect.objectContaining({ monitor: scenario.expectedMonitor, width: scenario.expectedWidth }),
    ]);
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
    peer.channel.receive(jpegFrame(1, { jpegWidth: 641 }));
    await flush();
    fixture.detectChanges();
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(root.querySelector('.notice')?.textContent).toContain('Não foi possível');
  });

  it.each([
    { monitorWidth: 1920, monitorHeight: 1081, width: 1280, height: 722 },
    { monitorWidth: 100, monitorHeight: 400, width: 101, height: 400 },
    { monitorWidth: 100, monitorHeight: 400, width: 100, height: 401 },
  ])(
    'rejects $width × $height before decoding for a $monitorWidth × $monitorHeight monitor',
    async ({ monitorWidth, monitorHeight, width, height }) => {
      const { fixture, peer, root, action } = setup();
      action().click();
      await flush();
      peer.channel.receive(
        JSON.stringify({
          ...MONITOR,
          monitors: [{ ...MONITOR.monitors[0], width: monitorWidth, height: monitorHeight }],
        }),
      );
      fixture.detectChanges();
      peer.channel.receive(jpegFrame(1, { width, height }));
      await flush();
      fixture.detectChanges();

      expect(createImageBitmap).not.toHaveBeenCalled();
      expect(drawImage).not.toHaveBeenCalled();
      expect(root.querySelector('.notice')?.textContent).toContain('Não foi possível');
    },
  );

  it('decodes and paints a frame at the rounded height limit of the requested width', async () => {
    const width = 1280;
    const height = 721;
    const bitmap = { width, height, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    );
    const { fixture, peer, root, action } = setup();
    action().click();
    await flush();
    peer.channel.receive(
      JSON.stringify({
        ...MONITOR,
        monitors: [{ ...MONITOR.monitors[0], height: 1081 }],
      }),
    );
    fixture.detectChanges();
    peer.channel.receive(jpegFrame(1, { width, height }));
    await flush();

    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
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
    it('zooming and panning with two fingers never click nor move the PC pointer, not even a tap still waiting', async () => {
      const { fire, direct, store, fixture, root } = await touching();
      // Um toque que ainda espera o segundo e, logo depois, a pinça: o toque que esperava é descartado.
      fire('pointerdown', 100, 100, 1);
      fire('pointerup', 100, 100, 1);
      vi.advanceTimersByTime(50);
      fire('pointerdown', 100, 100, 1);
      fire('pointerdown', 200, 100, 2);
      fire('pointermove', 300, 100, 2);
      // Os dois dedos andam juntos: só desloca a imagem ampliada.
      fire('pointermove', 80, 60, 1);
      fire('pointermove', 280, 60, 2);
      fire('pointerup', 80, 60, 1);
      fire('pointerup', 280, 60, 2);
      vi.advanceTimersByTime(1000);
      fixture.detectChanges();
      expect(root.querySelector<HTMLElement>('.view')!.style.transform).toContain('scale(');
      expect(direct.command).not.toHaveBeenCalled();
      expect(direct.sendAbsolute).not.toHaveBeenCalled();
      expect(store.click).not.toHaveBeenCalled();
      expect(store.movePointer).not.toHaveBeenCalled();
    });
  });

  describe('typing and full screen', () => {
    async function live({ touch = true } = {}) {
      const kit = setup();
      kit.touchOn.set(touch);
      await kit.open(TWO_MONITORS);
      kit.peer.channel.receive(jpegFrame(1));
      await flush();
      kit.fixture.detectChanges();
      const keyboardButton = () => kit.root.querySelector<HTMLButtonElement>('button.keyboard');
      const fullscreenButton = () =>
        kit.root.querySelector<HTMLButtonElement>('button.fullscreen')!;
      const shell = () => kit.root.querySelector<HTMLElement>('.shell')!;
      const field = () => kit.root.querySelector<HTMLTextAreaElement>('textarea')!;
      const click = (button: HTMLButtonElement) => {
        button.click();
        kit.fixture.detectChanges();
      };
      return { ...kit, keyboardButton, fullscreenButton, shell, field, click };
    }

    /** O jsdom não tem a Fullscreen API: o teste a instala e a tira. */
    function installFullscreen({ refuse = false } = {}) {
      let element: Element | null = null;
      const grant = (target: Element) => {
        if (refuse) return Promise.reject(new Error('recusada'));
        element = target;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };
      const request = vi.fn(function (this: Element) {
        return grant(this);
      });
      const exit = vi.fn(() => {
        element = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      });
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
        value: request,
        configurable: true,
      });
      Object.defineProperty(document, 'exitFullscreen', { value: exit, configurable: true });
      Object.defineProperty(document, 'fullscreenElement', {
        get: () => element,
        configurable: true,
      });
      /** O navegador saiu sozinho (Esc, voltar do Android). */
      const leaveBySystem = () => {
        element = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      return { request, exit, leaveBySystem };
    }

    afterEach(() => {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    });

    it('the keyboard button opens the phone keyboard and what is typed goes to the PC at once', async () => {
      const { keyboardButton, field, click, store } = await live();
      const button = keyboardButton()!;
      expect(button.textContent).toContain('Teclado');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      click(button);
      expect(document.activeElement).toBe(field());
      expect(button.getAttribute('aria-pressed')).toBe('true');
      field().value = SENTINEL + 'olá';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      expect(store.sendText.mock.calls).toEqual([['olá']]);
      // Tocar de novo fecha o teclado.
      click(button);
      expect(document.activeElement).not.toBe(field());
      expect(button.getAttribute('aria-pressed')).toBe('false');
    });

    it('keeps the typed text out of the page and out of storage', async () => {
      const { keyboardButton, field, click, root } = await live();
      click(keyboardButton()!);
      field().value = SENTINEL + 'segredo123';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      expect(root.textContent).not.toContain('segredo123');
      const stored = [localStorage, sessionStorage].flatMap((area) =>
        Array.from({ length: area.length }, (_, index) => area.getItem(area.key(index)!) ?? ''),
      );
      expect(stored.some((value) => value.includes('segredo123'))).toBe(false);
    });

    it('typing follows the input access: no keyboard while the PC cannot take input', async () => {
      const { keyboardButton, field, store, fixture } = await live();
      store.phase.set('offline');
      fixture.detectChanges();
      expect(keyboardButton()!.disabled).toBe(true);
      expect(field().disabled).toBe(true);
    });

    it('offers the keyboard without the touch capability, since typing is the usual PC input', async () => {
      const { keyboardButton, root } = await live({ touch: false });
      expect(root.querySelector('.tools')).toBeNull();
      expect(keyboardButton()).not.toBeNull();
    });

    it('enters and leaves full screen through the API, keeping the session, the monitor and the zoom', async () => {
      const api = installFullscreen();
      const { fullscreenButton, shell, click, root, createPeer, signaling, requests } =
        await live();
      // Escolhe o monitor que não é o principal.
      const monitorButtons = root.querySelectorAll<HTMLButtonElement>('.monitors button');
      click(monitorButtons[0]);
      expect(monitorButtons[0].getAttribute('aria-pressed')).toBe('true');
      const asked = requests().length;
      click(fullscreenButton());
      expect(api.request).toHaveBeenCalledOnce();
      expect(api.request.mock.contexts[0]).toBe(shell());
      expect(shell().classList).toContain('full');
      expect(shell().classList).not.toContain('pseudo');
      expect(fullscreenButton().textContent).toContain('Sair da tela cheia');
      expect(fullscreenButton().getAttribute('aria-pressed')).toBe('true');
      // A sessão segue a mesma: nenhuma oferta nova, nenhum fechamento, o monitor escolhido continua.
      expect(createPeer).toHaveBeenCalledOnce();
      expect(signaling.close).not.toHaveBeenCalled();
      expect(monitorButtons[0].getAttribute('aria-pressed')).toBe('true');
      expect(requests().length).toBe(asked);
      click(fullscreenButton());
      expect(api.exit).toHaveBeenCalledOnce();
      expect(shell().classList).not.toContain('full');
      expect(fullscreenButton().textContent).toContain('Tela cheia');
      expect(monitorButtons[0].getAttribute('aria-pressed')).toBe('true');
      expect(createPeer).toHaveBeenCalledOnce();
    });

    it('follows the browser when it leaves full screen by itself', async () => {
      const api = installFullscreen();
      const { fullscreenButton, shell, click, fixture } = await live();
      click(fullscreenButton());
      api.leaveBySystem();
      fixture.detectChanges();
      expect(shell().classList).not.toContain('full');
      expect(fullscreenButton().getAttribute('aria-pressed')).toBe('false');
    });

    it('falls back to the CSS full screen without the API (iPhone) and leaves it with the button or Escape', async () => {
      const { fullscreenButton, shell, click, fixture, createPeer } = await live();
      click(fullscreenButton());
      expect(shell().classList).toContain('full');
      expect(shell().classList).toContain('pseudo');
      shell().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();
      expect(shell().classList).not.toContain('full');
      click(fullscreenButton());
      expect(shell().classList).toContain('pseudo');
      click(fullscreenButton());
      expect(shell().classList).not.toContain('full');
      expect(createPeer).toHaveBeenCalledOnce();
    });

    it('in full screen the failure of a key that did not reach the PC still shows', async () => {
      const { fullscreenButton, click, root, store, fixture } = await live();
      store.notice.set({ kind: 'network', message: 'Sem conexão com o PC.' });
      fixture.detectChanges();
      // Fora da tela cheia o aviso é da casca do módulo, não desta página.
      expect(root.querySelector('.fullscreen-notice')).toBeNull();
      click(fullscreenButton());
      expect(root.querySelector('.fullscreen-notice')?.textContent).toContain(
        'Sem conexão com o PC.',
      );
      expect(root.querySelector('.fullscreen-notice')?.getAttribute('role')).toBe('alert');
    });

    it('uses the CSS full screen when the browser says full screen is not allowed', async () => {
      installFullscreen();
      Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true });
      try {
        const { fullscreenButton, shell, click } = await live();
        click(fullscreenButton());
        expect(shell().classList).toContain('pseudo');
        expect(HTMLElement.prototype.requestFullscreen).not.toHaveBeenCalled();
      } finally {
        delete (document as { fullscreenEnabled?: unknown }).fullscreenEnabled;
      }
    });

    it('falls back to the CSS full screen when the browser refuses the API', async () => {
      installFullscreen({ refuse: true });
      const { fullscreenButton, shell, click, fixture } = await live();
      click(fullscreenButton());
      await flush();
      fixture.detectChanges();
      expect(shell().classList).toContain('pseudo');
    });

    it('the zoom survives entering full screen', async () => {
      installFullscreen();
      const { fullscreenButton, click, root, fixture } = await live();
      const stage = root.querySelector<HTMLElement>('.stage')!;
      Object.defineProperty(stage, 'clientWidth', { value: 400, configurable: true });
      Object.defineProperty(stage, 'clientHeight', { value: 225, configurable: true });
      stage.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
      const fire = (type: string, x: number, pointer: number) => {
        const event = new MouseEvent(type, { clientX: x, clientY: 100, bubbles: true });
        Object.defineProperty(event, 'pointerId', { value: pointer });
        stage.dispatchEvent(event);
      };
      fire('pointerdown', 150, 1);
      fire('pointerdown', 250, 2);
      fire('pointermove', 350, 2);
      fire('pointerup', 150, 1);
      fire('pointerup', 350, 2);
      fixture.detectChanges();
      const zoomed = root.querySelector<HTMLElement>('.view')!.style.transform;
      expect(zoomed).toContain('scale(');
      click(fullscreenButton());
      expect(root.querySelector<HTMLElement>('.view')!.style.transform).toBe(zoomed);
    });

    it('keeps the way out of full screen when the screen stops', async () => {
      const { fullscreenButton, shell, click, action } = await live();
      click(fullscreenButton());
      click(action());
      expect(shell().classList).toContain('full');
      click(fullscreenButton());
      expect(shell().classList).not.toContain('full');
    });

    it('leaving the page ends the API full screen', async () => {
      const api = installFullscreen();
      const { fullscreenButton, click, fixture } = await live();
      click(fullscreenButton());
      fixture.destroy();
      expect(api.exit).toHaveBeenCalledOnce();
      expect(document.fullscreenElement).toBeNull();
    });

    it('leaving the page does not touch a full screen that belongs to someone else', async () => {
      const api = installFullscreen();
      const { fixture } = await live();
      await document.body.requestFullscreen();
      fixture.destroy();
      expect(api.exit).not.toHaveBeenCalled();
    });
  });
});
