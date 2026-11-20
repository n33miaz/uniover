import { ScreenFrameBuffer, ScreenMetrics, readScreenMarker } from './screen-metrics';

describe('Métricas da tela do PC', () => {
  const header = { bytes: 8, cpu: 19, privateMB: 64 };

  it('monta a imagem em ordem e recusa pedaços fora do quadro', () => {
    const buffer = new ScreenFrameBuffer();
    const first = new ArrayBuffer(5);
    const last = new ArrayBuffer(3);

    expect(() => buffer.chunk(first)).toThrow();
    expect(() => buffer.header({ ...header, bytes: 9 * 1024 ** 2 })).toThrow();
    buffer.header(header);
    expect(buffer.chunk(first)).toBeNull();
    expect(() => buffer.header(header)).toThrow();
    expect(() => buffer.chunk(first)).toThrow();
    expect(buffer.chunk(last)).toMatchObject({ ...header, chunks: [first, last] });
    expect(() => buffer.chunk(last)).toThrow();
  });

  it('lê os bits do quadrado após a decodificação', () => {
    const testMarker = 0xa437;
    const coordinates: number[][] = [];
    expect(
      readScreenMarker((x, y) => {
        coordinates.push([x, y]);
        return testMarker & (1 << ((x - 4) / 8)) ? 240 : 15;
      }),
    ).toBe(testMarker);
    expect(coordinates).toHaveLength(16);
    expect(coordinates.at(-1)).toEqual([124, 4]);
  });

  it('conta só os toques confirmados na imagem e pongs durante a chegada de quadros', () => {
    const stats = new ScreenMetrics(100, 500);
    stats.pointerRtt(400, 110);

    stats.touch(150);
    const first = stats.request();
    stats.touch(200);
    stats.frame(header, 1280, first, 270);
    stats.pointerRtt(10, 280);

    const second = stats.request();
    stats.frame(header, 1280, first, 300);
    expect(stats.result(300).touchCount).toBe(1);
    expect(stats.request()).toBe(second);
    stats.frame({ ...header, cpu: 22, privateMB: 60 }, 1280, second, 500);
    stats.pointerRtt(10, 510);
    stats.pointerRtt(20, 590);

    stats.frame(header, 1280, stats.request(), 600);
    expect(stats.result(1000).concurrent).toBe(false);
    expect(stats.result(1100, true).concurrent).toBe(false);
    expect(stats.result(1000, true)).toMatchObject({ pointerGap: 410, concurrent: true });
    expect(stats.result(1100)).toMatchObject({
      seconds: 1,
      width: 1280,
      frames: 4,
      fps: 4,
      mbps: 0.000256,
      touchP50: 120,
      touchP95: 300,
      touchCount: 2,
      pointerP95: 20,
      pointerCount: 3,
      cpu: 19,
      privateMB: 64,
      pointerGap: 510,
      concurrent: false,
    });
  });
});
