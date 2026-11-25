import {
  ScreenFrameLoop,
  ScreenViewerFrameAssembler,
  parseViewerMessage,
  type ScreenViewRequest,
} from './screen-viewer';

const VIEW: ScreenViewRequest = { monitor: 1, width: 1280 };

/** Um quadro no formato do PC: `>4sBBHHHI` (marca, versão, reservado, largura, altura, sequência, tamanho). */
function frameBytes(
  sequence: number,
  jpeg: number[],
  header: Record<string, number> = {},
): ArrayBuffer {
  const h = {
    magic: 0x554f5346,
    version: 1,
    flags: 0,
    width: 640,
    height: 360,
    size: jpeg.length,
    ...header,
  };
  const bytes = new Uint8Array(16 + jpeg.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, h['magic']);
  view.setUint8(4, h['version']);
  view.setUint8(5, h['flags']);
  view.setUint16(6, h['width']);
  view.setUint16(8, h['height']);
  view.setUint16(10, sequence);
  view.setUint32(12, h['size']);
  bytes.set(jpeg, 16);
  return bytes.buffer;
}

describe('parseViewerMessage', () => {
  it('reads the monitor list sent first by the PC', () => {
    const text =
      '{"k":"s.mon","monitors":[{"id":1,"width":1920,"height":1080,"primary":true},' +
      '{"id":2,"width":1280,"height":1024,"primary":false}]}';
    expect(parseViewerMessage(text)).toEqual({
      k: 's.mon',
      monitors: [
        { id: 1, width: 1920, height: 1080, primary: true },
        { id: 2, width: 1280, height: 1024, primary: false },
      ],
      layout: null,
    });
  });

  it('reads the layout print the tap sends back, and an older PC without it', () => {
    const monitors = '[{"id":0,"width":1920,"height":1080,"primary":true}]';
    expect(parseViewerMessage(`{"k":"s.mon","monitors":${monitors},"layout":4294967295}`)).toEqual({
      k: 's.mon',
      monitors: [{ id: 0, width: 1920, height: 1080, primary: true }],
      layout: 4294967295,
    });
    for (const bad of ['-1', '4294967296', '1.5', '"7"', 'null']) {
      expect(() =>
        parseViewerMessage(`{"k":"s.mon","monitors":${monitors},"layout":${bad}}`),
      ).toThrow();
    }
  });

  it('reads cursor, same and state messages', () => {
    expect(parseViewerMessage('{"k":"s.cur","x":10,"y":20}')).toEqual({
      k: 's.cur',
      cursor: { x: 10, y: 20 },
    });
    expect(parseViewerMessage('{"k":"s.same","crc":4294967295}')).toEqual({
      k: 's.same',
      crc: 4294967295,
    });
    expect(parseViewerMessage('{"k":"s.state","state":"locked"}')).toEqual({
      k: 's.state',
      state: 'locked',
    });
  });

  it.each([
    '{"k":"s.mon"}',
    '{"k":"s.mon","width":1920,"height":1080}',
    '{"k":"s.mon","monitors":[]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":0,"height":10,"primary":true}]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":"a","primary":true}]}',
    '{"k":"s.mon","monitors":[{"id":"a","width":10,"height":10,"primary":true}]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":10}]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":10,"primary":true},{"id":1,"width":10,"height":10,"primary":false}]}',
    '{"k":"s.mon","monitors":[null]}',
    '{"k":"s.mon","monitors":[{"id":-1,"width":10,"height":10,"primary":true}]}',
    '{"k":"s.mon","monitors":[{"id":2147483648,"width":10,"height":10,"primary":true}]}',
    '{"k":"s.cur","x":"a","y":2}',
    '{"k":"s.cur","x":1}',
    '{"k":"s.state","state":"x"}',
    '{"k":"s.same"}',
    '{"k":"s.same","crc":-1}',
    '{"k":"s.same","crc":4294967296}',
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
    expect(frame).toMatchObject({ sequence: 3, width: 640, height: 360 });
    expect(frame?.chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(8);
  });

  it('returns a frame that fits in one message', () => {
    expect(new ScreenViewerFrameAssembler().push(frameBytes(1, [9, 9]))).toMatchObject({
      sequence: 1,
    });
  });

  it('requires the UOSF header: a bare JPEG is refused', () => {
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(() => new ScreenViewerFrameAssembler().push(jpeg.buffer)).toThrow('cabeçalho');
  });

  it('refuses another version', () => {
    expect(() => new ScreenViewerFrameAssembler().push(frameBytes(1, [1], { version: 2 }))).toThrow(
      'cabeçalho',
    );
  });

  it('rejects a wrong magic, an empty frame and an overflowing chunk', () => {
    const assembler = new ScreenViewerFrameAssembler();
    expect(() => assembler.push(frameBytes(1, [1], { magic: 1 }))).toThrow();
    expect(() => assembler.push(new Uint8Array(16).buffer)).toThrow();
    assembler.push(frameBytes(1, [1, 2], { size: 3 }));
    expect(() => assembler.push(new Uint8Array(5).buffer)).toThrow();
    // Depois do erro o montador volta a esperar um cabeçalho.
    expect(assembler.push(frameBytes(2, [1]))).toMatchObject({ sequence: 2 });
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

  it('asks with the fields the PC reads, and resets its counters on the first request only', () => {
    const loop = make(5);
    loop.start();
    expect(sent).toEqual([{ k: 's.get', monitor: 1, width: 1280, fps: 5, marker: 0, reset: true }]);
    loop.answered();
    vi.advanceTimersByTime(250);
    expect(sent[1]).toEqual({
      k: 's.get',
      monitor: 1,
      width: 1280,
      fps: 5,
      marker: 0,
      reset: false,
    });
    loop.stop();
  });

  it('asks for one frame at a time and the next only after the answer', () => {
    const loop = make();
    loop.start();
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(1);
    loop.answered();
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(2);
    loop.stop();
  });

  it('spaces requests by the frame rate', () => {
    const loop = make(5);
    loop.start();
    vi.advanceTimersByTime(50);
    loop.answered();
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(60);
    expect(sent).toHaveLength(2);
    loop.stop();
  });

  it('ignores an answer when nothing is pending', () => {
    const loop = make();
    loop.start();
    expect(loop.answered()).toBe(true);
    expect(loop.answered()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(2);
    loop.stop();
  });

  it('waits for the monitor size before asking', () => {
    view = null;
    const loop = make();
    loop.start();
    expect(sent).toHaveLength(0);
    view = VIEW;
    loop.start();
    expect(sent).toHaveLength(1);
    expect(sent[0]['reset']).toBe(true);
    loop.stop();
  });

  it('restart with a request pending keeps it and sends the new view only after the answer', () => {
    const loop = make();
    loop.start();
    view = { monitor: 2, width: 640 };
    loop.restart();
    vi.advanceTimersByTime(5_000);
    expect(sent.map((m) => m['width'])).toEqual([1280]);

    expect(loop.answered()).toBe(true);
    vi.advanceTimersByTime(0);
    expect(sent.map((m) => m['width'])).toEqual([1280, 640]);
    expect(sent.map((m) => m['monitor'])).toEqual([1, 2]);
    expect(sent.map((m) => m['reset'])).toEqual([true, true]);
    loop.stop();
  });

  it('restart(lost) drops the pending request, stops its watchdog and asks at once with the new view', () => {
    const loop = make();
    loop.start();
    view = { monitor: 2, width: 640 };
    loop.restart(true);
    expect(sent.map((m) => m['monitor'])).toEqual([1, 2]);
    expect(sent[1]['reset']).toBe(true);
    // O pedido perdido não pode mais gerar timeout; o novo, sim, e só no seu prazo.
    vi.advanceTimersByTime(9_999);
    expect(timeouts).toBe(0);
    vi.advanceTimersByTime(2);
    expect(timeouts).toBe(1);
    loop.stop();
  });

  it('restart(lost) with nothing pending behaves like restart', () => {
    const loop = make();
    loop.start();
    loop.answered();
    loop.restart(true);
    expect(sent).toHaveLength(2);
    loop.stop();
  });

  it('restart with nothing pending asks at once', () => {
    const loop = make();
    loop.start();
    loop.answered();
    view = { monitor: 2, width: 640 };
    loop.restart();
    expect(sent.map((m) => m['width'])).toEqual([1280, 640]);
    expect(sent[1]['monitor']).toBe(2);
    expect(sent[1]['reset']).toBe(true);
    loop.stop();
  });

  it('slows down while the answer is a locked state', () => {
    const loop = make();
    loop.start();
    loop.answered(true);
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
