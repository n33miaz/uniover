import { CURSOR_REWIND_MS, rewindCursor } from './cursor';

// Mesmo formato do servidor: base64url sem preenchimento de "<ticks>|<uuid>".
function encode(ticks: bigint, id = 'f2d8a1f0-1c5e-4a77-9a8e-3b6f7c1d2e90'): string {
  return btoa(`${ticks}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(cursor: string): { ticks: bigint; id: string } {
  const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
  const [ticks, id] = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')).split('|');
  return { ticks: BigInt(ticks), id };
}

// 2026-10-19 em ticks do .NET: passa de 2^53, onde `Number` perde precisão.
const NOW_TICKS = 639_120_000_000_000_001n;

describe('rewindCursor', () => {
  it('uses two minutes as the safety margin', () => {
    expect(CURSOR_REWIND_MS).toBe(120_000);
  });

  it('moves the instant back exactly, without losing precision on big tick counts', () => {
    expect(NOW_TICKS > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    const rewound = rewindCursor(encode(NOW_TICKS), CURSOR_REWIND_MS);

    expect(rewound).not.toBeNull();
    expect(decode(rewound as string).ticks).toBe(NOW_TICKS - 1_200_000_000n);
  });

  it('uses the lowest id so every row at the rewound instant is included', () => {
    const rewound = rewindCursor(encode(NOW_TICKS), 1_000) as string;
    expect(decode(rewound).id).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('keeps the url-safe alphabet and no padding, as the server writes it', () => {
    for (const offset of [0n, 1n, 2n, 3n, 7n, 123_456_789n]) {
      const rewound = rewindCursor(encode(NOW_TICKS + offset), 5_000) as string;
      expect(rewound).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never goes below zero', () => {
    const rewound = rewindCursor(encode(5_000n), CURSOR_REWIND_MS) as string;
    expect(decode(rewound).ticks).toBe(0n);
  });

  it('returns null for a cursor it cannot read, so the caller pulls from the start', () => {
    expect(rewindCursor('###', 1000)).toBeNull();
    expect(rewindCursor(btoa('sem-separador'), 1000)).toBeNull();
    expect(rewindCursor(btoa('abc|def'), 1000)).toBeNull();
    expect(rewindCursor(btoa('1|2|3'), 1000)).toBeNull();
  });
});
