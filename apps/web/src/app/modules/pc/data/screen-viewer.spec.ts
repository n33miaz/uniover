import {
  ScreenFrameLoop,
  ScreenViewerFrameAssembler,
  parseViewerMessage,
  type ScreenViewRequest,
} from './screen-viewer';

const VIEW: ScreenViewRequest = { monitor: 1, width: 1280 };
// SOI, APP0, SOF0 de 640 × 360 com um componente e EOI.
const JPEG = [
  0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 104, 2, 128, 1, 1, 0x11, 0, 0xff,
  0xd9,
];

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

  it('reads monitor origins (x and y) when present, including negative coordinates', () => {
    const text =
      '{"k":"s.mon","monitors":[' +
      '{"id":1,"width":1920,"height":1080,"primary":true,"x":0,"y":0},' +
      '{"id":2,"width":1280,"height":1024,"primary":false,"x":-1280,"y":-200}' +
      ']}';
    expect(parseViewerMessage(text)).toEqual({
      k: 's.mon',
      monitors: [
        { id: 1, width: 1920, height: 1080, primary: true, x: 0, y: 0 },
        { id: 2, width: 1280, height: 1024, primary: false, x: -1280, y: -200 },
      ],
      layout: null,
    });
  });

  it('accepts left and top as fallback for x and y in monitor origins', () => {
    const text =
      '{"k":"s.mon","monitors":[' +
      '{"id":1,"width":1920,"height":1080,"primary":true,"left":1920,"top":0}' +
      ']}';
    expect(parseViewerMessage(text)).toEqual({
      k: 's.mon',
      monitors: [{ id: 1, width: 1920, height: 1080, primary: true, x: 1920, y: 0 }],
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
    expect(parseViewerMessage(`{"k":"s.mon","monitors":${monitors},"layout":null}`)).toMatchObject({
      layout: null,
    });
    for (const bad of ['-1', '4294967296', '1.5', '"7"']) {
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
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":10,"primary":true,"x":"a"}]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":10,"primary":true,"y":1.5}]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":10,"primary":true,"x":100001}]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":10,"primary":true,"left":"b"}]}',
    '{"k":"s.mon","monitors":[{"id":1,"width":10,"height":10,"primary":true,"top":1.5}]}',
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
    const packet = frameBytes(3, JPEG);
    expect(assembler.push(packet.slice(0, 21), VIEW.width)).toBeNull();
    expect(assembler.push(packet.slice(21, 31), VIEW.width)).toBeNull();
    const frame = assembler.push(packet.slice(31), VIEW.width);
    expect(frame).toMatchObject({
      sequence: 3,
      width: 640,
      height: 360,
      wireBytes: packet.byteLength,
    });
    expect(frame?.chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(JPEG.length);
  });

  it('returns a frame that fits in one message', () => {
    expect(new ScreenViewerFrameAssembler().push(frameBytes(1, JPEG), VIEW.width)).toMatchObject({
      sequence: 1,
    });
  });

  it('requires the UOSF header: a bare JPEG is refused', () => {
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(() => new ScreenViewerFrameAssembler().push(jpeg.buffer, VIEW.width)).toThrow(
      'cabeçalho',
    );
  });

  it('refuses another version', () => {
    expect(() =>
      new ScreenViewerFrameAssembler().push(frameBytes(1, JPEG, { version: 2 }), VIEW.width),
    ).toThrow('cabeçalho');
  });

  it('rejects a wrong magic, an empty frame and an overflowing chunk', () => {
    const assembler = new ScreenViewerFrameAssembler();
    expect(() => assembler.push(frameBytes(1, [1], { magic: 1 }), VIEW.width)).toThrow();
    expect(() => assembler.push(new Uint8Array(16).buffer, VIEW.width)).toThrow();
    assembler.push(frameBytes(1, [1, 2], { size: 3 }), VIEW.width);
    expect(() => assembler.push(new Uint8Array(5).buffer, VIEW.width)).toThrow();
    // Depois do erro o montador volta a esperar um cabeçalho.
    expect(assembler.push(frameBytes(2, JPEG), VIEW.width)).toMatchObject({ sequence: 2 });
  });

  it('recusa dimensões divergentes, JPEG sem SOF e segmentos truncados', () => {
    const assembler = new ScreenViewerFrameAssembler();
    expect(() => assembler.push(frameBytes(1, JPEG, { height: 361 }), VIEW.width)).toThrow(
      'diverge',
    );
    expect(() => assembler.push(frameBytes(1, [0xff, 0xd8, 0xff, 0xd9]), VIEW.width)).toThrow(
      'sem dimensões',
    );
    expect(() => assembler.push(frameBytes(1, JPEG.slice(0, 17)), VIEW.width)).toThrow('segmento');
  });

  it('limita largura ao pedido e pixels ao teto, aceitando 8K em retrato reduzido', () => {
    const assembler = new ScreenViewerFrameAssembler();
    expect(() => assembler.push(frameBytes(1, JPEG), 639)).toThrow('cabeçalho');
    expect(() => assembler.push(frameBytes(1, JPEG, { width: 1920, height: 4321 }), 1920)).toThrow(
      'cabeçalho',
    );
    const portrait = JPEG.slice();
    portrait.splice(13, 4, 0x0d, 0x55, 0x07, 0x80);
    expect(
      assembler.push(frameBytes(1, portrait, { width: 1920, height: 3413 }), 1920),
    ).toMatchObject({ width: 1920, height: 3413 });
  });

  it('recusa continuação vazia e o fragmento 514 mesmo abaixo de 8 MiB', () => {
    const assembler = new ScreenViewerFrameAssembler();
    const first = frameBytes(1, [1], { size: 514 });
    expect(assembler.push(first, VIEW.width)).toBeNull();
    expect(() => assembler.push(new ArrayBuffer(0), VIEW.width)).toThrow('pedaço');
    expect(assembler.push(first, VIEW.width)).toBeNull();
    for (let i = 1; i < 513; i++) {
      expect(assembler.push(new ArrayBuffer(1), VIEW.width)).toBeNull();
    }
    expect(() => assembler.push(new ArrayBuffer(1), VIEW.width)).toThrow('pedaço');
  });

  it('aceita os 513 fragmentos de um JPEG de 8 MiB enviado em blocos de 16 KiB', () => {
    const assembler = new ScreenViewerFrameAssembler();
    const size = 8 * 1024 ** 2;
    const chunkBytes = 16 * 1024;
    const packet = new Uint8Array(16 + size);
    packet.set(new Uint8Array(frameBytes(1, JPEG, { size })));
    for (let offset = 0; offset < size; offset += chunkBytes) {
      expect(
        assembler.push(packet.buffer.slice(offset, offset + chunkBytes), VIEW.width),
      ).toBeNull();
    }
    expect(assembler.push(packet.buffer.slice(size), VIEW.width)?.chunks).toHaveLength(513);
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
