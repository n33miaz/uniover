import { PagerHost, StagePager } from './stage-pager';

describe('StagePager', () => {
  const WIDTH = 300;
  let left: number;
  let reduced: boolean;
  let scrollTo: ReturnType<typeof vi.fn<(left: number, smooth: boolean) => void>>;
  let pager: StagePager;

  const host: PagerHost = {
    width: () => WIDTH,
    left: () => left,
    scrollTo: (target, smooth) => scrollTo(target, smooth),
    reducedMotion: () => reduced,
  };

  /** Move o elemento de mentira para `to` e avisa o carrossel, como o navegador faria durante a rolagem. */
  const scrollBy = (to: number) => {
    left = to;
    pager.scrolled();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    left = 0;
    reduced = false;
    scrollTo = vi.fn();
    pager = new StagePager(host, 3);
  });

  afterEach(() => {
    pager.destroy();
    vi.useRealTimers();
  });

  describe('a page asked for by a dot or a key', () => {
    it('marks the destination at once and never passes through the pages on the way', () => {
      const seen: number[] = [];
      const record = () => {
        if (seen[seen.length - 1] !== pager.page()) seen.push(pager.page());
      };
      pager.goTo(2);
      record();
      for (const position of [10, 90, 200, 400, 560, 600]) {
        scrollBy(position);
        record();
      }
      expect(seen).toEqual([2]);
      expect(scrollTo).toHaveBeenCalledWith(600, true);
      expect(pager.progress()).toBe(2);
    });

    it('is instant when the reader asked for less motion', () => {
      reduced = true;
      pager.goTo(1);
      expect(scrollTo).toHaveBeenCalledWith(300, false);
    });

    it('does nothing when it is already there, and clamps to the first and last page', () => {
      pager.goTo(0);
      expect(scrollTo).not.toHaveBeenCalled();
      pager.goTo(9);
      expect(pager.page()).toBe(2);
      expect(scrollTo).toHaveBeenLastCalledWith(600, true);
      pager.goTo(-4);
      expect(pager.page()).toBe(0);
    });

    it('forces the position if the animation never arrives', () => {
      pager.goTo(1);
      scrollBy(40);
      vi.advanceTimersByTime(900);
      expect(scrollTo).toHaveBeenLastCalledWith(300, false);
      expect(pager.page()).toBe(1);
    });

    it('a finger that starts dragging takes over from the pending request', () => {
      pager.goTo(2);
      scrollBy(100);
      pager.touchStart(200, 0);
      pager.touchDragged(220, 10);
      scrollBy(250);
      expect(pager.page()).toBe(1);
      pager.touchEnd();
      scrollBy(300);
      vi.advanceTimersByTime(300);
      expect(pager.page()).toBe(1);
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('a plain tap on the screen during the animation does not interrupt it', () => {
      pager.goTo(2);
      scrollBy(100);
      pager.touchStart(200, 0);
      pager.touchEnd(30);
      scrollBy(250);
      expect(pager.page()).toBe(2);
    });
  });

  describe('a drag by finger', () => {
    it('follows the position, switching the page at the middle', () => {
      pager.touchStart(250, 0);
      pager.touchDragged(100, 100);
      scrollBy(140);
      expect(pager.page()).toBe(0);
      scrollBy(160);
      expect(pager.page()).toBe(1);
      expect(pager.progress()).toBeCloseTo(160 / WIDTH);
    });

    it('does not correct anything while the finger is still down, even if it pauses', () => {
      pager.touchStart(250, 0);
      pager.touchDragged(150, 100);
      scrollBy(100);
      vi.advanceTimersByTime(2000);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('a page left stuck in the middle moves on past the threshold, and goes back before it', () => {
      pager.touchStart(250, 0);
      pager.touchDragged(200, 600);
      scrollBy(60);
      pager.touchEnd(2000);
      vi.advanceTimersByTime(140);
      expect(scrollTo).toHaveBeenLastCalledWith(300, true);
      expect(pager.page()).toBe(1);

      scrollBy(300);
      expect(pager.page()).toBe(1);
      pager.touchStart(250, 3000);
      pager.touchDragged(240, 3600);
      scrollBy(300 + 30);
      pager.touchEnd(5000);
      vi.advanceTimersByTime(140);
      expect(scrollTo).toHaveBeenLastCalledWith(300, true);
      expect(pager.page()).toBe(1);
    });

    it('a drag backwards past the threshold goes to the previous page', () => {
      scrollBy(300);
      pager.touchStart(100, 0);
      pager.touchDragged(150, 500);
      scrollBy(250);
      pager.touchEnd(2000);
      vi.advanceTimersByTime(140);
      expect(scrollTo).toHaveBeenLastCalledWith(0, true);
      expect(pager.page()).toBe(0);
    });

    it('leaves a settled page alone', () => {
      pager.touchStart(250, 0);
      pager.touchDragged(100, 100);
      scrollBy(300);
      pager.touchEnd(2000);
      vi.advanceTimersByTime(500);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(pager.page()).toBe(1);
    });
  });

  describe('a quick flick', () => {
    const flickForward = () => {
      pager.touchStart(300, 0);
      pager.touchDragged(250, 10);
      pager.touchDragged(200, 20);
      pager.touchDragged(150, 30);
      scrollBy(90);
      pager.touchEnd(35);
    };

    it('turns the page even though it did not pass the middle, in the direction of the finger', () => {
      flickForward();
      // Nada é pedido na hora: o navegador está começando o encaixe dele e uma rolagem pedida agora perderia a disputa.
      expect(scrollTo).not.toHaveBeenCalled();
      // O encaixe do navegador devolve a página de origem e, quando a rolagem para, a página pedida vale.
      for (const position of [60, 30, 0]) scrollBy(position);
      vi.advanceTimersByTime(140);
      expect(scrollTo).toHaveBeenLastCalledWith(300, true);
      expect(pager.page()).toBe(1);
    });

    it('asks for nothing when the browser already took the flick to the next page', () => {
      flickForward();
      for (const position of [150, 240, 300]) scrollBy(position);
      vi.advanceTimersByTime(500);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(pager.page()).toBe(1);
    });

    it('forgets the flick when the finger comes back or a dot is chosen before the scroll stops', () => {
      flickForward();
      pager.touchStart(100, 100);
      pager.touchEnd(110);
      scrollBy(0);
      vi.advanceTimersByTime(500);
      expect(scrollTo).not.toHaveBeenCalled();

      flickForward();
      pager.goTo(2);
      expect(scrollTo).toHaveBeenLastCalledWith(600, true);
      scrollBy(0);
      vi.advanceTimersByTime(140);
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('goes back with a flick to the right', () => {
      scrollBy(300);
      pager.touchStart(50, 0);
      pager.touchDragged(100, 10);
      pager.touchDragged(150, 20);
      pager.touchDragged(200, 30);
      scrollBy(210);
      pager.touchEnd(35);
      expect(scrollTo).not.toHaveBeenCalled();
      for (const position of [250, 300]) scrollBy(position);
      vi.advanceTimersByTime(140);
      expect(scrollTo).toHaveBeenLastCalledWith(0, true);
    });

    it('does not turn the page on a slow drag, a long pause before lifting, or a tremor', () => {
      pager.touchStart(300, 0);
      pager.touchDragged(280, 400);
      scrollBy(60);
      pager.touchEnd(450);
      expect(scrollTo).not.toHaveBeenCalled();

      pager.touchStart(300, 1000);
      pager.touchDragged(250, 1010);
      pager.touchDragged(200, 1020);
      scrollBy(100);
      pager.touchEnd(1400);
      expect(scrollTo).not.toHaveBeenCalled();

      scrollBy(0);
      pager.touchStart(300, 2000);
      pager.touchDragged(290, 2005);
      pager.touchDragged(270, 2010);
      scrollBy(3);
      pager.touchEnd(2015);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('never goes past the first or the last page', () => {
      pager.touchStart(50, 0);
      pager.touchDragged(100, 10);
      pager.touchDragged(200, 20);
      scrollBy(0);
      pager.touchEnd(25);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe('size and tab changes', () => {
    it('puts the chosen page back in view when the size changed under it', () => {
      pager.goTo(1);
      scrollBy(300);
      scrollTo.mockClear();
      left = 270;
      pager.realign();
      expect(scrollTo).toHaveBeenCalledWith(300, false);
    });

    it('does not fight a finger or a pending request', () => {
      pager.touchStart(0, 0);
      left = 120;
      pager.realign();
      pager.touchEnd();
      pager.goTo(2);
      scrollTo.mockClear();
      pager.realign();
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('opens on the saved page without animation', () => {
      pager.restore(2);
      expect(scrollTo).toHaveBeenCalledWith(600, false);
      expect(pager.page()).toBe(2);
    });
  });
});
