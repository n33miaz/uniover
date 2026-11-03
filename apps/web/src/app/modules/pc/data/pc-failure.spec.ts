import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { ApiProblem } from '../../../core/auth/api-problem';
import { pcFailureOf } from './pc-failure';

function http(status: number, error: unknown = null): HttpErrorResponse {
  return new HttpErrorResponse({ status, error, headers: new HttpHeaders() });
}

describe('pcFailureOf', () => {
  it('says there is no connection when the server did not answer', () => {
    expect(pcFailureOf(http(0)).kind).toBe('network');
  });

  it.each([
    [401, 'session'],
    [429, 'rate-limited'],
    [400, 'invalid'],
    [404, 'not-found'],
    [409, 'unavailable'],
    [503, 'offline'],
    [504, 'timeout'],
  ])('maps HTTP %i to %s', (status, kind) => {
    expect(pcFailureOf(http(status)).kind).toBe(kind);
  });

  it('tells a missing permission apart from other 403 answers', () => {
    const forbidden = http(403, { type: 'https://uniover.dev/problems/forbidden', title: 'x' });
    expect(pcFailureOf(forbidden).kind).toBe('forbidden');
    expect(
      pcFailureOf(http(403, { type: 'https://uniover.dev/problems/step-up-required' })).kind,
    ).toBe('failed');
  });

  it('a favorite that disappeared from the PC is explained, not shown as a code', () => {
    const failure = pcFailureOf(http(502, { agentError: 'unknown_app' }));
    expect(failure.kind).toBe('failed');
    expect(failure.message).toBe('Esse atalho não existe mais neste PC.');
  });

  it('any other failure from the PC is generic and never shows a code', () => {
    const failure = pcFailureOf(http(502, { agentError: 'failed' }));
    expect(failure.message).toBe('O PC não executou o comando.');
    expect(failure.message).not.toContain('failed');
  });

  it('accepts an already-read problem and survives something that is not an HTTP error', () => {
    expect(pcFailureOf(new ApiProblem(503, 'agent-offline', 'x')).kind).toBe('offline');
    expect(pcFailureOf(new Error('boom')).kind).toBe('unknown');
  });
});
