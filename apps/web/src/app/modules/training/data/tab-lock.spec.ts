import { TAB_LOCK_WAIT_MS, withTabLock } from './tab-lock';
import { exclusiveLocks, grantEverything, installLocks, removeLocks } from './tab-lock-test-kit';

/** Deixa passar o que já está na fila de microtarefas e dos temporizadores curtos. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Uma tarefa que anota quando começa e termina, e só termina quando o teste manda. */
function gatedTask(log: string[], label: string) {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  return {
    finish,
    run: async () => {
      log.push(`${label}:start`);
      await gate;
      log.push(`${label}:end`);
      return label;
    },
  };
}

describe('withTabLock', () => {
  afterEach(() => {
    removeLocks();
    vi.useRealTimers();
  });

  describe('without navigator.locks (this tab only)', () => {
    it('runs the tasks of the same name one at a time, in the order they came', async () => {
      const log: string[] = [];
      const a = gatedTask(log, 'a');
      const b = gatedTask(log, 'b');

      const first = withTabLock('conta-1', a.run);
      const second = withTabLock('conta-1', b.run);
      await flush();
      expect(log).toEqual(['a:start']);

      a.finish();
      await first;
      b.finish();
      expect(await second).toBe('b');
      expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('does not make different names wait for each other', async () => {
      const log: string[] = [];
      const a = gatedTask(log, 'a');
      const b = gatedTask(log, 'b');

      const first = withTabLock('conta-1', a.run);
      const second = withTabLock('conta-2', b.run);
      await flush();

      expect(log).toEqual(['a:start', 'b:start']);
      a.finish();
      b.finish();
      await Promise.all([first, second]);
    });

    it('lets the next task run when the previous one fails, and gives each caller its own outcome', async () => {
      const failing = withTabLock('conta-1', () => Promise.reject(new Error('quebrou')));
      const next = withTabLock('conta-1', () => Promise.resolve('seguiu'));

      await expect(failing).rejects.toThrow('quebrou');
      await expect(next).resolves.toBe('seguiu');
    });

    it('can be used again after the queue emptied', async () => {
      await withTabLock('conta-1', () => Promise.resolve(1));

      await expect(withTabLock('conta-1', () => Promise.resolve(2))).resolves.toBe(2);
    });
  });

  describe('with navigator.locks', () => {
    it('asks the browser for the lock by name and runs the task inside it', async () => {
      const locks = exclusiveLocks();
      installLocks(locks.manager);

      const value = await withTabLock('uniover-training-start:conta-1', () => Promise.resolve(7));

      expect(value).toBe(7);
      expect(locks.requested).toEqual(['uniover-training-start:conta-1']);
    });

    it('waits for the other tab to let go before running', async () => {
      const locks = exclusiveLocks();
      installLocks(locks.manager);
      const otherTab = locks.hold('conta-1');
      const log: string[] = [];
      const mine = gatedTask(log, 'mine');

      const done = withTabLock('conta-1', mine.run);
      await flush();
      expect(log).toEqual([]);

      otherTab.release();
      await vi.waitFor(() => expect(log).toEqual(['mine:start']));
      mine.finish();
      expect(await done).toBe('mine');
    });

    it('gives up waiting after the limit and runs the task anyway, never leaving the button stuck', async () => {
      vi.useFakeTimers();
      const locks = exclusiveLocks();
      installLocks(locks.manager);
      locks.hold('conta-1');
      const task = vi.fn(() => Promise.resolve('rodou'));

      const done = withTabLock('conta-1', task);
      await vi.advanceTimersByTimeAsync(TAB_LOCK_WAIT_MS - 1);
      expect(task).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(done).resolves.toBe('rodou');
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('runs the task once even when the browser refuses the request', async () => {
      installLocks({
        request: () => Promise.reject(new DOMException('recusado', 'SecurityError')),
      });
      const task = vi.fn(() => Promise.resolve('rodou'));

      await expect(withTabLock('conta-1', task)).resolves.toBe('rodou');
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('does not run a task again when the task itself failed inside the lock', async () => {
      installLocks(grantEverything());
      const task = vi.fn(() => Promise.reject(new Error('quebrou dentro')));

      await expect(withTabLock('conta-1', task)).rejects.toThrow('quebrou dentro');
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('does not let a long task be cut by the waiting limit', async () => {
      vi.useFakeTimers();
      installLocks(exclusiveLocks().manager);
      const log: string[] = [];
      const slow = gatedTask(log, 'slow');

      const done = withTabLock('conta-1', slow.run);
      await vi.advanceTimersByTimeAsync(TAB_LOCK_WAIT_MS * 3);
      slow.finish();

      await expect(done).resolves.toBe('slow');
      expect(log).toEqual(['slow:start', 'slow:end']);
    });
  });
});
