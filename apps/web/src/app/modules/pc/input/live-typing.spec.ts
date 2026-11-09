import type { PcFailure } from '../data/pc-failure';
import {
  PC_TEXT_ERASE_CHUNK,
  type PcKey,
  type PcModifier,
  type PcTextEdit,
} from '../data/pc-types';
import {
  LiveTyper,
  MAX_TEXT,
  PADDING_CHAR,
  diffText,
  editRequests,
  fieldDiff,
  fieldState,
  mergeDiff,
  textSteps,
} from './live-typing';

describe('diffText', () => {
  it('typing at the end only adds', () => {
    expect(diffText('ab', 'abc')).toEqual({ erase: 0, insert: 'c' });
    expect(diffText('', 'olá')).toEqual({ erase: 0, insert: 'olá' });
  });

  it('deleting at the end only erases', () => {
    expect(diffText('abc', 'ab')).toEqual({ erase: 1, insert: '' });
    expect(diffText('abc', '')).toEqual({ erase: 3, insert: '' });
  });

  it('a replaced word erases the changed tail and types the new one', () => {
    expect(diffText('hello wrld', 'hello world')).toEqual({ erase: 3, insert: 'orld' });
    expect(diffText('abc', 'xyz')).toEqual({ erase: 3, insert: 'xyz' });
  });

  it('an edit in the middle erases from there and retypes the rest', () => {
    expect(diffText('abcd', 'abXcd')).toEqual({ erase: 2, insert: 'Xcd' });
  });

  it('an equal text is no change', () => {
    expect(diffText('same', 'same')).toEqual({ erase: 0, insert: '' });
  });

  it('counts code points: an emoji is one, never two halves', () => {
    expect(diffText('a😀', 'a')).toEqual({ erase: 1, insert: '' });
    expect(diffText('a', 'a😀😀')).toEqual({ erase: 0, insert: '😀😀' });
    expect(diffText('😀a', '😁a')).toEqual({ erase: 2, insert: '😁a' });
  });
});

describe('fieldDiff', () => {
  const pad = PADDING_CHAR.repeat(6);

  it('splits the field into typed text and padding', () => {
    expect(fieldState(pad + 'ab')).toEqual({ typed: 'ab', padding: 6 });
    expect(fieldState('a' + pad + 'b')).toEqual({ typed: 'ab', padding: 6 });
    expect(fieldState('')).toEqual({ typed: '', padding: 0 });
  });

  it('typing is a diff of the typed text only: the padding never travels as text', () => {
    const { diff } = fieldDiff(fieldState(pad), pad + 'a');
    expect(diff).toEqual({ erase: 0, insert: 'a' });
    // Digitar antes do preenchimento (o cursor no começo do campo) dá o mesmo texto.
    expect(fieldDiff(fieldState(pad), 'a' + pad).diff).toEqual({ erase: 0, insert: 'a' });
  });

  it('erasing padding alone is one Backspace per character gone (Backspace on an empty field)', () => {
    expect(fieldDiff(fieldState(pad), pad.slice(1)).diff).toEqual({ erase: 1, insert: '' });
    expect(fieldDiff(fieldState(pad), '').diff).toEqual({ erase: 6, insert: '' });
  });

  it('when the typed text changes too, only that change counts (select all and type over)', () => {
    expect(fieldDiff(fieldState(pad + 'ab'), 'c').diff).toEqual({ erase: 2, insert: 'c' });
    expect(fieldDiff(fieldState(pad), 'c').diff).toEqual({ erase: 0, insert: 'c' });
  });

  it('more padding (the field was refilled) is no change', () => {
    expect(fieldDiff(fieldState(pad.slice(2)), pad).diff).toEqual({ erase: 0, insert: '' });
  });
});

describe('mergeDiff', () => {
  it('two appends become one', () => {
    expect(mergeDiff({ erase: 0, insert: 'ab' }, { erase: 0, insert: 'c' })).toEqual({
      erase: 0,
      insert: 'abc',
    });
  });

  it('what the second erases of the first never goes out', () => {
    expect(mergeDiff({ erase: 0, insert: 'abc' }, { erase: 2, insert: 'x' })).toEqual({
      erase: 0,
      insert: 'ax',
    });
  });

  it('what the second erases beyond the first is erased in the PC', () => {
    expect(mergeDiff({ erase: 1, insert: 'ab' }, { erase: 5, insert: 'z' })).toEqual({
      erase: 4,
      insert: 'z',
    });
  });

  it('works by code points', () => {
    expect(mergeDiff({ erase: 0, insert: 'a😀' }, { erase: 1, insert: 'b' })).toEqual({
      erase: 0,
      insert: 'ab',
    });
  });
});

describe('textSteps', () => {
  it('plain text is one step', () => {
    expect(textSteps('olá, mundo')).toEqual([{ kind: 'text', text: 'olá, mundo' }]);
    expect(textSteps('')).toEqual([]);
  });

  it('Enter and Tab are keys, never text, and the text around them keeps its place', () => {
    expect(textSteps('a\nb\tc')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'key', key: 'ENTER' },
      { kind: 'text', text: 'b' },
      { kind: 'key', key: 'TAB' },
      { kind: 'text', text: 'c' },
    ]);
  });

  it('a Windows line break is a single Enter', () => {
    expect(textSteps('a\r\nb')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'key', key: 'ENTER' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('drops the other control characters', () => {
    expect(textSteps('a\u0000b\u001bc')).toEqual([{ kind: 'text', text: 'abc' }]);
  });

  it('cuts a long text at the contract limit, in code points', () => {
    const steps = textSteps('😀'.repeat(MAX_TEXT + 50));
    expect(steps).toHaveLength(2);
    expect(Array.from((steps[0] as { text: string }).text)).toHaveLength(MAX_TEXT);
    expect(Array.from((steps[1] as { text: string }).text)).toHaveLength(50);
  });
});

describe('LiveTyper', () => {
  interface Call {
    readonly what: 'key' | 'text';
    readonly value: string;
    readonly modifiers?: readonly PcModifier[];
    resolve(failure?: PcFailure | null): void;
  }

  let calls: Call[];
  let failures: PcFailure[];
  let dropped: boolean[];
  let idles: number;
  let typer: LiveTyper;

  const FAILED: PcFailure = { kind: 'timeout', message: 'O PC não respondeu a tempo.' };
  /** Deixa as continuações dos pedidos já respondidos rodarem. */
  const flush = async () => {
    for (let round = 0; round < 6; round++) await Promise.resolve();
  };
  /** Responde, sem falha, ao pedido mais antigo em voo. */
  const answer = async (failure: PcFailure | null = null) => {
    calls.shift()!.resolve(failure);
    await flush();
  };
  const sent = () => calls.map((call) => `${call.what}:${call.value}`);

  beforeEach(() => {
    calls = [];
    failures = [];
    dropped = [];
    idles = 0;
    typer = new LiveTyper(
      {
        key: (key: PcKey, modifiers: readonly PcModifier[]) =>
          new Promise((resolve) =>
            calls.push({ what: 'key', value: key, modifiers, resolve: (f = null) => resolve(f) }),
          ),
        text: (text: string) =>
          new Promise((resolve) =>
            calls.push({ what: 'text', value: text, resolve: (f = null) => resolve(f) }),
          ),
      },
      {
        failed: (failure, _kind, droppedEdits) => {
          failures.push(failure);
          dropped.push(droppedEdits);
        },
        idle: () => idles++,
      },
    );
  });

  it('sends the first change at once, one request in flight', () => {
    typer.edit({ erase: 0, insert: 'a' });
    expect(sent()).toEqual(['text:a']);
    expect(typer.pending).toBe(1);
  });

  it('joins what is typed while a request is in flight into one request', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.edit({ erase: 0, insert: 'b' });
    typer.edit({ erase: 0, insert: 'c' });
    typer.edit({ erase: 0, insert: 'd' });
    expect(sent()).toEqual(['text:a']);
    expect(typer.pending).toBe(2);
    await answer();
    expect(sent()).toEqual(['text:bcd']);
    await answer();
    expect(typer.pending).toBe(0);
    expect(idles).toBe(1);
  });

  it('what is erased before it went out never goes out', async () => {
    typer.edit({ erase: 0, insert: 'x' });
    typer.edit({ erase: 0, insert: 'ab' });
    typer.edit({ erase: 2, insert: '' });
    await answer();
    // "ab" foi digitado e apagado antes de sair: nada mais a enviar.
    expect(sent()).toEqual([]);
    expect(idles).toBe(1);
  });

  it('erasing is one Backspace key per code point, in order, before the new text', async () => {
    typer.edit({ erase: 2, insert: 'xy' });
    expect(sent()).toEqual(['key:BACKSPACE']);
    await answer();
    expect(sent()).toEqual(['key:BACKSPACE']);
    await answer();
    expect(sent()).toEqual(['text:xy']);
  });

  it('a key never passes ahead of the text typed before it', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.edit({ erase: 0, insert: 'bc' });
    typer.key('ENTER');
    typer.edit({ erase: 0, insert: 'd' });
    expect(sent()).toEqual(['text:a']);
    await answer();
    expect(sent()).toEqual(['text:bc']);
    await answer();
    expect(sent()).toEqual(['key:ENTER']);
    await answer();
    expect(sent()).toEqual(['text:d']);
  });

  it('keys keep their modifiers', () => {
    typer.key('C', ['CTRL']);
    expect(calls[0].modifiers).toEqual(['CTRL']);
  });

  it('a line break typed or pasted goes as the Enter key, not as text', async () => {
    typer.edit({ erase: 0, insert: 'a\nb' });
    expect(sent()).toEqual(['text:a']);
    await answer();
    expect(sent()).toEqual(['key:ENTER']);
    await answer();
    expect(sent()).toEqual(['text:b']);
  });

  it('a failure drops what was waiting, tells the screen once, and the next change works', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.edit({ erase: 0, insert: 'b' });
    typer.key('ENTER');
    await answer(FAILED);
    expect(failures).toEqual([FAILED]);
    expect(sent()).toEqual([]);
    expect(typer.pending).toBe(0);

    typer.edit({ erase: 0, insert: 'z' });
    expect(sent()).toEqual(['text:z']);
  });

  it('a failure in the middle of erasing stops the erasing', async () => {
    typer.edit({ erase: 3, insert: 'x' });
    await answer();
    await answer(FAILED);
    expect(failures).toHaveLength(1);
    expect(sent()).toEqual([]);
  });

  it('clear throws away what has not gone out and the one in flight ends quietly', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.edit({ erase: 0, insert: 'b' });
    typer.clear();
    expect(typer.pending).toBe(1);
    await answer();
    expect(sent()).toEqual([]);
    expect(failures).toEqual([]);
    expect(typer.pending).toBe(0);
  });

  it('counts what is waiting for the key repeat to hold back', () => {
    typer.key('BACKSPACE');
    typer.key('BACKSPACE');
    typer.key('BACKSPACE');
    expect(typer.pending).toBe(3);
  });
});

describe('LiveTyper: discarded edits and a queue that goes on', () => {
  const FAILED: PcFailure = { kind: 'timeout', message: 'Tempo.' };
  let pending: { what: string; resolve: (failure?: PcFailure | null) => void }[];
  let reported: { kind: string; droppedEdits: boolean }[];
  let typer: LiveTyper;
  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  const answer = async (failure: PcFailure | null = null) => {
    pending.shift()!.resolve(failure);
    await flush();
  };

  beforeEach(() => {
    pending = [];
    reported = [];
    typer = new LiveTyper(
      {
        key: (key) =>
          new Promise((resolve) =>
            pending.push({ what: 'key:' + key, resolve: (f = null) => resolve(f) }),
          ),
        text: (text) =>
          new Promise((resolve) =>
            pending.push({ what: 'text:' + text, resolve: (f = null) => resolve(f) }),
          ),
      },
      {
        failed: (_failure, kind, droppedEdits) => reported.push({ kind, droppedEdits }),
        idle: () => undefined,
      },
    );
  });

  it('a key that fails with a typed text waiting behind it says the text was dropped', async () => {
    typer.key('ENTER');
    typer.edit({ erase: 0, insert: 'abc' });
    await answer(FAILED);
    expect(reported).toEqual([{ kind: 'key', droppedEdits: true }]);
    expect(pending).toEqual([]);
  });

  it('a key that fails with only keys behind it drops no text', async () => {
    typer.key('ENTER');
    typer.key('TAB');
    await answer(FAILED);
    expect(reported).toEqual([{ kind: 'key', droppedEdits: false }]);
  });

  it('an edit that fails with another edit behind it says it too', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.key('ENTER');
    typer.edit({ erase: 0, insert: 'b' });
    await answer(FAILED);
    expect(reported).toEqual([{ kind: 'edit', droppedEdits: true }]);
  });

  it('after clear() with a step in flight, what is asked next is not stuck behind it', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.clear();
    typer.edit({ erase: 0, insert: 'b' });
    expect(pending.map((step) => step.what)).toEqual(['text:a']);
    await answer();
    // O passo em voo terminou; o que veio depois do clear() sai sem esperar outro toque.
    expect(pending.map((step) => step.what)).toEqual(['text:b']);
    await answer();
    expect(typer.pending).toBe(0);
  });

  it('a failure of the step cleared in flight is not reported', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.clear();
    await answer(FAILED);
    expect(reported).toEqual([]);
  });
});

describe('editRequests', () => {
  it('a burst typed at the end is one request', () => {
    expect(editRequests({ erase: 0, insert: 'olá' })).toEqual([{ text: 'olá' }]);
  });

  it('a replaced word is one request: erase, then type', () => {
    expect(editRequests({ erase: 3, insert: 'casa' })).toEqual([{ erase: 3, text: 'casa' }]);
  });

  it('only erasing is one request with no text', () => {
    expect(editRequests({ erase: 5, insert: '' })).toEqual([{ erase: 5 }]);
  });

  it('a final Enter or Tab goes in the same request, after the text', () => {
    expect(editRequests({ erase: 2, insert: 'ok\n' })).toEqual([
      { erase: 2, text: 'ok', key: 'ENTER' },
    ]);
    expect(editRequests({ erase: 0, insert: 'a\t' })).toEqual([{ text: 'a', key: 'TAB' }]);
  });

  it('a line break alone is a request that only presses the key (and keeps the erase)', () => {
    expect(editRequests({ erase: 0, insert: '\n' })).toEqual([{ key: 'ENTER' }]);
    expect(editRequests({ erase: 4, insert: '\n' })).toEqual([{ erase: 4, key: 'ENTER' }]);
  });

  it('text after a key starts a new request: the key is always the last thing a request does', () => {
    expect(editRequests({ erase: 1, insert: 'a\nb' })).toEqual([
      { erase: 1, text: 'a', key: 'ENTER' },
      { text: 'b' },
    ]);
    expect(editRequests({ erase: 0, insert: 'a\n\nb\tc' })).toEqual([
      { text: 'a', key: 'ENTER' },
      { key: 'ENTER' },
      { text: 'b', key: 'TAB' },
      { text: 'c' },
    ]);
  });

  it('a Windows line break is a single Enter', () => {
    expect(editRequests({ erase: 0, insert: 'a\r\nb' })).toEqual([
      { text: 'a', key: 'ENTER' },
      { text: 'b' },
    ]);
  });

  it('a text longer than the contract limit goes in several requests, in order', () => {
    const text = 'x'.repeat(MAX_TEXT + 30);
    expect(editRequests({ erase: 2, insert: text })).toEqual([
      { erase: 2, text: 'x'.repeat(MAX_TEXT) },
      { text: 'x'.repeat(30) },
    ]);
  });

  it('an erase beyond the chunk goes in blocks, and what is left goes with the text', () => {
    expect(editRequests({ erase: PC_TEXT_ERASE_CHUNK * 2 + 7, insert: 'z' })).toEqual([
      { erase: PC_TEXT_ERASE_CHUNK },
      { erase: PC_TEXT_ERASE_CHUNK },
      { erase: 7, text: 'z' },
    ]);
    expect(editRequests({ erase: PC_TEXT_ERASE_CHUNK, insert: '' })).toEqual([
      { erase: PC_TEXT_ERASE_CHUNK },
    ]);
  });

  it('never asks for more than the contract allows in one request', () => {
    for (const erase of [1, 79, 80, 81, 160, 161, 500]) {
      for (const request of editRequests({ erase, insert: 'a\nb' })) {
        expect(request.erase ?? 0).toBeLessThanOrEqual(PC_TEXT_ERASE_CHUNK);
        expect(request.text?.length ?? 0).toBeLessThanOrEqual(MAX_TEXT);
      }
    }
  });

  it('the control characters other than Enter and Tab never travel', () => {
    expect(editRequests({ erase: 0, insert: 'a\u0007b\u0000' })).toEqual([{ text: 'ab' }]);
  });

  it('no change is no request', () => {
    expect(editRequests({ erase: 0, insert: '' })).toEqual([]);
  });

  it('an emoji counts as one character: the erase is by code point', () => {
    expect(editRequests({ erase: 1, insert: '😀' })).toEqual([{ erase: 1, text: '😀' }]);
  });
});

describe('LiveTyper on a PC that understands pc.text.v2', () => {
  interface Call {
    readonly what: 'key' | 'text' | 'edit';
    readonly value: string;
    resolve(failure?: PcFailure | null): void;
  }

  let calls: Call[];
  let failures: PcFailure[];
  let supported: boolean;
  let typer: LiveTyper;

  const FAILED: PcFailure = { kind: 'timeout', message: 'O PC não respondeu a tempo.' };
  const flush = async () => {
    for (let round = 0; round < 6; round++) await Promise.resolve();
  };
  const answer = async (failure: PcFailure | null = null) => {
    calls.shift()!.resolve(failure);
    await flush();
  };
  const sent = () => calls.map((call) => `${call.what}:${call.value}`);

  beforeEach(() => {
    calls = [];
    failures = [];
    supported = true;
    typer = new LiveTyper(
      {
        key: (key: PcKey) =>
          new Promise((resolve) =>
            calls.push({ what: 'key', value: key, resolve: (f = null) => resolve(f) }),
          ),
        text: (text: string) =>
          new Promise((resolve) =>
            calls.push({ what: 'text', value: text, resolve: (f = null) => resolve(f) }),
          ),
        edit: (edit: PcTextEdit) =>
          new Promise((resolve) =>
            calls.push({
              what: 'edit',
              value: JSON.stringify(edit),
              resolve: (f = null) => resolve(f),
            }),
          ),
        canEdit: () => supported,
      },
      { failed: (failure) => failures.push(failure), idle: () => undefined },
    );
  });

  it('erase and new text are ONE request, not one per erased character', () => {
    typer.edit({ erase: 4, insert: 'casa' });
    expect(sent()).toEqual(['edit:{"erase":4,"text":"casa"}']);
  });

  it('a burst typed while a request is in flight costs one request, not one per letter', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.edit({ erase: 0, insert: 'b' });
    typer.edit({ erase: 0, insert: 'c' });
    typer.edit({ erase: 1, insert: 'd' });
    expect(sent()).toEqual(['edit:{"text":"a"}']);
    await answer();
    // O "b", o "c" e o apagar do "c" com o "d" juntaram numa diferença só: digita "bd".
    expect(sent()).toEqual(['edit:{"text":"bd"}']);
    await answer();
    expect(calls).toHaveLength(0);
  });

  it('a final Enter goes in the same request as the text before it', () => {
    typer.edit({ erase: 0, insert: 'ok\n' });
    expect(sent()).toEqual(['edit:{"text":"ok","key":"ENTER"}']);
  });

  it('text after a line break goes in the next request, in order', async () => {
    typer.edit({ erase: 0, insert: 'a\nb' });
    expect(sent()).toEqual(['edit:{"text":"a","key":"ENTER"}']);
    await answer();
    expect(sent()).toEqual(['edit:{"text":"b"}']);
  });

  it('a key never passes ahead of the edit typed before it', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.edit({ erase: 2, insert: 'bc' });
    typer.key('ENTER');
    expect(sent()).toEqual(['edit:{"text":"a"}']);
    await answer();
    expect(sent()).toEqual(['edit:{"erase":2,"text":"bc"}']);
    await answer();
    expect(sent()).toEqual(['key:ENTER']);
  });

  it('a failure drops what was waiting, as with the request per key', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    typer.edit({ erase: 0, insert: 'b' });
    await answer(FAILED);
    expect(failures).toEqual([FAILED]);
    expect(calls).toHaveLength(0);
  });

  it('a failure in the middle of a long erase stops the rest of it', async () => {
    typer.edit({ erase: 200, insert: 'x' });
    expect(sent()).toEqual([`edit:{"erase":${PC_TEXT_ERASE_CHUNK}}`]);
    await answer(FAILED);
    expect(calls).toHaveLength(0);
    expect(failures).toEqual([FAILED]);
  });

  it('a long erase goes in blocks, one after the other', async () => {
    typer.edit({ erase: PC_TEXT_ERASE_CHUNK + 5, insert: 'x' });
    expect(sent()).toEqual([`edit:{"erase":${PC_TEXT_ERASE_CHUNK}}`]);
    await answer();
    expect(sent()).toEqual(['edit:{"erase":5,"text":"x"}']);
  });

  it('on a PC that does not understand it, each erase is a Backspace key and the text goes as before', async () => {
    supported = false;
    typer.edit({ erase: 2, insert: 'xy' });
    expect(sent()).toEqual(['key:BACKSPACE']);
    await answer();
    await answer();
    expect(sent()).toEqual(['text:xy']);
  });

  it('follows the PC: the answer to "supported" is read at each request', async () => {
    typer.edit({ erase: 0, insert: 'a' });
    expect(sent()).toEqual(['edit:{"text":"a"}']);
    supported = false;
    typer.edit({ erase: 1, insert: 'b' });
    await answer();
    expect(sent()).toEqual(['key:BACKSPACE']);
  });
});
