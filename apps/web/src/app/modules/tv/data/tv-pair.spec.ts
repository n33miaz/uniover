import { HttpErrorResponse } from '@angular/common/http';
import { cleanPairCode, isPairCode, pairFailureOf } from './tv-pair';

const failure = (status: number, body: Record<string, unknown>) =>
  pairFailureOf(new HttpErrorResponse({ status, error: body }));

describe('tv-pair', () => {
  describe('cleanPairCode', () => {
    it('keeps only hexadecimal characters, uppercase, up to 6', () => {
      expect(cleanPairCode('a1b2c3')).toBe('A1B2C3');
      expect(cleanPairCode(' a1 b2-c3 ')).toBe('A1B2C3');
      expect(cleanPairCode('zzz9')).toBe('9');
      expect(cleanPairCode('a1b2c3d4e5')).toBe('A1B2C3');
      expect(cleanPairCode('')).toBe('');
    });
  });

  describe('isPairCode', () => {
    it('accepts exactly 6 hexadecimal characters', () => {
      expect(isPairCode('A1B2C3')).toBe(true);
      expect(isPairCode('000000')).toBe(true);
      expect(isPairCode('A1B2C')).toBe(false);
      expect(isPairCode('A1B2C3D')).toBe(false);
      expect(isPairCode('a1b2c3')).toBe(false);
      expect(isPairCode('G1B2C3')).toBe(false);
    });
  });

  describe('pairFailureOf', () => {
    it('recognizes an old computer by the problem type', () => {
      expect(failure(409, { type: 'https://uniover.dev/problems/pair-unsupported' })).toBe(
        'unsupported',
      );
    });

    it('recognizes a non-owner', () => {
      expect(failure(403, { type: 'https://uniover.dev/problems/forbidden' })).toBe('forbidden');
    });

    it('tells a request that came too soon apart from a plain failure', () => {
      expect(failure(429, { type: 'https://uniover.dev/problems/pair-too-soon' })).toBe('wait');
    });

    it('treats an offline or slow agent, and a TV that does not answer, as unreachable', () => {
      expect(failure(503, { type: 'https://uniover.dev/problems/agent-offline' })).toBe(
        'unreachable',
      );
      expect(failure(504, { type: 'https://uniover.dev/problems/agent-timeout' })).toBe(
        'unreachable',
      );
      expect(failure(502, { agentError: 'tv_unreachable' })).toBe('unreachable');
    });

    it.each(['invalid_code', 'pair_closed', 'pair_timeout', 'pair_not_started'])(
      'asks for a new code when the agent says %s',
      (code) => {
        expect(failure(502, { agentError: code })).toBe('code');
      },
    );

    it('keeps everything else as a plain failure', () => {
      expect(failure(502, { agentError: 'pair_failed' })).toBe('failed');
      expect(failure(500, {})).toBe('failed');
      expect(pairFailureOf(new Error('x'))).toBe('failed');
    });
  });
});
