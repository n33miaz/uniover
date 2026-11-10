import {
  CLIENTS_REPLY,
  LIST_CLIENTS_MESSAGE,
  LIST_CLIENTS_TIMEOUT_MS,
  answerClientsQuery,
  type ClientsReply,
} from './sw-clients';
import { askWorkerForOtherWindows } from './ask-worker-windows';
import { installFakeMessageChannel } from './sw-clients-test-kit';

describe('answerClientsQuery (no worker)', () => {
  const scope = (ids: string[]) => ({
    clients: { matchAll: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))) },
  });

  it('asks for every window of the app, controlled or not, and answers with the count', async () => {
    const worker = scope(['a', 'b', 'c']);
    const reply = { postMessage: vi.fn() };
    await answerClientsQuery(worker, 'b', reply);

    expect(worker.clients.matchAll).toHaveBeenCalledWith({
      type: 'window',
      includeUncontrolled: true,
    });
    expect(reply.postMessage).toHaveBeenCalledWith({
      type: CLIENTS_REPLY,
      count: 3,
      selfListed: true,
    });
  });

  it('says the asker is not listed when its id is unknown or missing, so the count cannot be trusted', async () => {
    const reply = { postMessage: vi.fn() };
    await answerClientsQuery(scope(['a']), 'zzz', reply);
    await answerClientsQuery(scope(['a']), null, reply);
    expect(reply.postMessage.mock.calls.map(([m]) => (m as ClientsReply).selfListed)).toEqual([
      false,
      false,
    ]);
  });

  it('does nothing without a port to answer on', async () => {
    const worker = scope(['a']);
    await answerClientsQuery(worker, 'a', undefined);
    expect(worker.clients.matchAll).not.toHaveBeenCalled();
  });
});

describe('askWorkerForOtherWindows (na página)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeMessageChannel();
  });

  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  /** Um worker que responde pela porta recebida, como o sw.ts faz. */
  function workerAnswering(reply: unknown) {
    return {
      postMessage: vi.fn((_message: unknown, transfer: Transferable[]) => {
        (transfer[0] as unknown as { postMessage(data: unknown): void }).postMessage(reply);
      }),
    };
  }

  it('asks the worker with a port and returns how many OTHER windows exist', async () => {
    const worker = workerAnswering({ type: CLIENTS_REPLY, count: 3, selfListed: true });
    expect(await askWorkerForOtherWindows(window, worker)).toBe(2);
    expect(worker.postMessage.mock.calls[0][0]).toEqual({ type: LIST_CLIENTS_MESSAGE });
    expect(worker.postMessage.mock.calls[0][1]).toHaveLength(1);
  });

  it('is zero when this is the only window', async () => {
    const worker = workerAnswering({ type: CLIENTS_REPLY, count: 1, selfListed: true });
    expect(await askWorkerForOtherWindows(window, worker)).toBe(0);
  });

  it.each([
    ['this window is not in the list', { type: CLIENTS_REPLY, count: 2, selfListed: false }],
    ['the count is zero', { type: CLIENTS_REPLY, count: 0, selfListed: true }],
    ['the count is not an integer', { type: CLIENTS_REPLY, count: 1.5, selfListed: true }],
    ['the count is not a number', { type: CLIENTS_REPLY, count: '2', selfListed: true }],
    ['the message is of another kind', { type: 'OUTRA', count: 2, selfListed: true }],
    ['the reply is empty', null],
  ])('fails closed (null) when %s', async (_name, reply) => {
    expect(await askWorkerForOtherWindows(window, workerAnswering(reply))).toBeNull();
  });

  it('fails closed when the worker never answers (a version that does not understand the question)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = { postMessage: vi.fn() };
    const asked = askWorkerForOtherWindows(window, worker);
    await vi.advanceTimersByTimeAsync(LIST_CLIENTS_TIMEOUT_MS);
    expect(await asked).toBeNull();
  });

  it('fails closed when the question cannot be sent', async () => {
    const worker = {
      postMessage: vi.fn(() => {
        throw new Error('worker terminou');
      }),
    };
    expect(await askWorkerForOtherWindows(window, worker)).toBeNull();
  });

  it('fails closed in a browser without MessageChannel', async () => {
    Object.defineProperty(window, 'MessageChannel', { value: undefined, configurable: true });
    const worker = { postMessage: vi.fn() };
    expect(await askWorkerForOtherWindows(window, worker)).toBeNull();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
