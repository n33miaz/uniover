import {
  ScreenFrameLoop,
  ScreenViewerFrameAssembler,
  parseViewerMessage,
  type ScreenViewRequest,
} from './screen-viewer';

const VIEW: ScreenViewRequest = {
  m: 1,
  x: 0,
  y: 0,
  w: 1920,
  h: 1080,
  maxW: 1280,
  maxH: 1280,
  q: 60,
};

function frameBytes(i: number, jpeg: number[], header: Record<string, number> = {}): ArrayBuffer {
  const h = {
    magic: 0x554f5346,
    version: 1,
    width: 640,
    height: 360,
    size: jpeg.length,
    ...header,
  };
  const bytes = new Uint8Array(16 + jpeg.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, h['magic']);
  view.setUint8(4, h['version']);
  view.setUint16(6, h['width']);
  view.setUint16(8, h['height']);
  view.setUint16(10, i);
  view.setUint32(12, h['size']);
  bytes.set(jpeg, 16);
  return bytes.buffer;
}

describe('parseViewerMessage', () => {
  it('reads the monitor list', () => {
    const message = parseViewerMessage(
      JSON.stringify({
        k: 's.mon',
        monitors: [
          { id: 5, x: 0, y: 0, w: 1920, h: 1080, primary: true },
          { id: 1, x: 1920, y: 176, w: 1280, h: 720, primary: false },
        ],
      }),
    );
    expect(message.k).toBe('s.mon');
    expect(message.k === 's.mon' && message.monitors.map((m) => m.id)).toEqual([5, 1]);
  });

  it('reads cursor, same and state messages', () => {
    expect(parseViewerMessage('{"k":"s.cur","m":1,"x":10,"y":20}')).toEqual({
      k: 's.cur',
      cursor: { m: 1, x: 10, y: 20 },
    });
    expect(parseViewerMessage('{"k":"s.same","i":7}')).toEqual({ k: 's.same', i: 7 });
    expect(parseViewerMessage('{"k":"s.state","state":"locked"}')).toEqual({
      k: 's.state',
      state: 'locked',
    });
  });

  it.each([
    '{"k":"s.mon","monitors":[]}',
    '{"k":"s.mon","monitors":[{"id":1,"x":0,"y":0,"w":0,"h":10}]}',
    '{"k":"s.cur","m":1,"x":"a","y":2}',
    '{"k":"s.state","state":"x"}',
    '{"k":"s.same"}',
    '{"k":"outra"}',
    'null',
  ])('rejects %s', (text) => {
    expect(() => parseViewerMessage(text)).toThrow();
  });
});

describe('ScreenViewerFrameAssembler', () => {
  it('assembles a frame split across messages', () => {
    const assembler = new ScreenViewerFrameAssembler();
    expect(assembler.push(frameBytes(3, [1, 2, 3, 4, 5], { size: 8 }))).toBeNull();
    const frame = assembler.push(new Uint8Array([6, 7, 8]).buffer);
    expect(frame).toMatchObject({ i: 3, width: 640, height: 360 });
    expect(frame?.chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(8);
  });

  it('returns a frame that fits in one message', () => {
    expect(new ScreenViewerFrameAssembler().push(frameBytes(1, [9, 9]))).toMatchObject({ i: 1 });
  });

  it('rejects a wrong magic, an empty frame and an overflowing chunk', () => {
    const assembler = new ScreenViewerFrameAssembler();
    expect(() => assembler.push(frameBytes(1, [1], { magic: 1 }))).toThrow();
    expect(() => assembler.push(new Uint8Array(16).buffer)).toThrow();
    assembler.push(frameBytes(1, [1, 2], { size: 3 }));
    expect(() => assembler.push(new Uint8Array(5).buffer)).toThrow();
    // Depois do erro o montador volta a esperar um cabeçalho.
    expect(assembler.push(frameBytes(2, [1]))).toMatchObject({ i: 2 });
  });
});

describe('ScreenFrameLoop', () => {
  let sent: Record<string, unknown>[];
  let timeouts: number;
  let view: ScreenViewRequest | null;

  const make = (fps = 5) =>
    new ScreenFrameLoop({
      send: (text) => sent.push(JSON.parse(text)),
      view: () => view,
      onTimeout: () => timeouts++,
      fps,
      timeoutMs: 10_000,
      slowMs: 1_000,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    timeouts = 0;
    view = VIEW;
  });
  afterEach(() => vi.useRealTimers());

  it('asks for one frame at a time and the next only after the answer', () => {
    const loop = make();
    loop.start();
    expect(sent).toEqual([{ k: 's.get', i: 1, ...VIEW }]);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(1);
    loop.answered(1);
    vi.advanceTimersByTime(250);
    expect(sent.map((m) => m['i'])).toEqual([1, 2]);
    loop.stop();
  });

  it('spaces requests by the frame rate', () => {
    const loop = make(5);
    loop.start();
    vi.advanceTimersByTime(50);
    loop.answered(1);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(60);
    expect(sent).toHaveLength(2);
    loop.stop();
  });

  it('ignores an answer to an old request', () => {
    const loop = make();
    loop.start();
    expect(loop.answered(99)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(1);
    loop.stop();
  });

  it('waits for the monitor list before asking', () => {
    view = null;
    const loop = make();
    loop.start();
    expect(sent).toHaveLength(0);
    view = VIEW;
    loop.start();
    expect(sent).toHaveLength(1);
    loop.stop();
  });

  it('restart drops the pending request and asks again with the new view', () => {
    const loop = make();
    loop.start();
    view = { ...VIEW, m: 5 };
    loop.restart();
    expect(sent.map((m) => [m['i'], m['m']])).toEqual([
      [1, 1],
      [2, 5],
    ]);
    expect(loop.answered(1)).toBe(false);
    loop.stop();
  });

  it('slows down while the answer is a locked state without a number', () => {
    const loop = make();
    loop.start();
    loop.answered(null, true);
    vi.advanceTimersByTime(900);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(2);
    loop.stop();
  });

  it('reports a timeout when the PC does not answer', () => {
    const loop = make();
    loop.start();
    vi.advanceTimersByTime(9_999);
    expect(timeouts).toBe(0);
    vi.advanceTimersByTime(2);
    expect(timeouts).toBe(1);
    loop.stop();
  });

  it('stops asking and does not report a timeout after stop', () => {
    const loop = make();
    loop.start();
    loop.stop();
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1);
    expect(timeouts).toBe(0);
    expect(loop.active).toBe(false);
  });
});
