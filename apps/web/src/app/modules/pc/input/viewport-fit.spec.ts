import { MIN_FIT_HEIGHT, availableHeight, watchAvailableHeight } from './viewport-fit';

describe('availableHeight', () => {
  const base = { viewportHeight: 664, keyboardInset: 0, top: 80, tabsHeight: 57, bottomGap: 0 };

  it('is what is left between where the screen starts and the tab bar', () => {
    expect(availableHeight(base)).toBe(527);
  });

  it('shrinks by the update notice that pushes the page down', () => {
    expect(availableHeight({ ...base, top: 80 + 60 })).toBe(467);
  });

  it('shrinks by the virtual keyboard that covers the window', () => {
    expect(availableHeight({ ...base, keyboardInset: 200 })).toBe(327);
  });

  it('never goes under the floor (landscape with the keyboard open)', () => {
    expect(availableHeight({ ...base, viewportHeight: 300, keyboardInset: 200 })).toBe(
      MIN_FIT_HEIGHT,
    );
  });

  it('leaves the breathing room the page keeps under the screen', () => {
    expect(availableHeight({ ...base, bottomGap: 16 })).toBe(511);
  });

  it('drops the fraction so the screen never pokes under the tab bar', () => {
    expect(availableHeight({ ...base, top: 80.7 })).toBe(526);
  });
});

describe('watchAvailableHeight', () => {
  afterEach(() => vi.restoreAllMocks());

  it('measures at once, again when the window resizes (one per frame), and stops listening', () => {
    const host = document.createElement('div');
    document.body.append(host);
    host.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const heights: number[] = [];
    const watch = watchAvailableHeight(document, host, (height) => heights.push(height));
    expect(heights).toHaveLength(1);
    expect(heights[0]).toBeGreaterThanOrEqual(MIN_FIT_HEIGHT);

    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(heights).toHaveLength(2);

    watch.remeasure();
    expect(heights).toHaveLength(3);

    watch.stop();
    window.dispatchEvent(new Event('resize'));
    expect(frames).toHaveLength(1);
    host.remove();
  });
});
