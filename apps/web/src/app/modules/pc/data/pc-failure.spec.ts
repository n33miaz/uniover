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

  it('tells a key the agent is too old for apart from a PC that is not available', () => {
    const unsupported = pcFailureOf(
      http(409, { type: 'https://uniover.dev/problems/pc-key-unsupported', title: 'x' }),
    );
    expect(unsupported.kind).toBe('key-unsupported');
    expect(unsupported.message).toBe('Atualize o agente do PC para usar este comando.');
    expect(
      pcFailureOf(http(409, { type: 'https://uniover.dev/problems/pc-unavailable', title: 'x' }))
        .kind,
    ).toBe('unavailable');
  });

  it('only a 409 can be a key the agent is too old for', () => {
    expect(
      pcFailureOf(http(400, { type: 'https://uniover.dev/problems/pc-key-unsupported' })).kind,
    ).toBe('invalid');
  });

  it('tells a PC that is reconnecting apart from one that is offline', () => {
    const reconnecting = pcFailureOf(
      http(503, { type: 'https://uniover.dev/problems/agent-reconnecting', title: 'x' }),
    );
    expect(reconnecting.kind).toBe('reconnecting');
    expect(reconnecting.message).toBe('O PC está reconectando.');
    const offline = pcFailureOf(
      http(503, { type: 'https://uniover.dev/problems/agent-offline', title: 'x' }),
    );
    expect(offline.kind).toBe('offline');
    expect(offline.message).toBe('O PC está desconectado.');
  });

  it('only a 503 can be a reconnecting PC', () => {
    expect(
      pcFailureOf(http(502, { type: 'https://uniover.dev/problems/agent-reconnecting' })).kind,
    ).toBe('failed');
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

  it('tells a locked PC apart from a window that needs administrator rights', () => {
    const locked = pcFailureOf(http(502, { agentError: 'session_locked' }));
    expect(locked.kind).toBe('locked');
    expect(locked.message).toBe('O PC está bloqueado.');
    const elevated = pcFailureOf(http(502, { agentError: 'elevated_window' }));
    expect(elevated.kind).toBe('elevated');
    expect(elevated.message).toBe('Há uma janela de administrador na frente.');
  });

  it('keeps the live keyboard from treating a locked PC as a silent failure', () => {
    expect(pcFailureOf(http(502, { agentError: 'session_locked' })).message).not.toContain(
      'session_locked',
    );
  });

  it('tells a device the owner has not approved yet from one the owner refused, and from a missing permission', () => {
    const pending = pcFailureOf(
      http(403, { type: 'https://uniover.dev/problems/pc-device-pending', title: 'x' }),
    );
    expect(pending.kind).toBe('device-pending');
    expect(pending.message).toBe('Aprove este aparelho no PC.');
    const denied = pcFailureOf(
      http(403, { type: 'https://uniover.dev/problems/pc-device-denied', title: 'x' }),
    );
    expect(denied.kind).toBe('device-denied');
    expect(denied.message).toBe('O dono do PC não permitiu este aparelho.');
    const unknown = pcFailureOf(
      http(403, { type: 'https://uniover.dev/problems/pc-device-unknown', title: 'x' }),
    );
    expect(unknown.kind).toBe('device-unknown');
    expect(
      pcFailureOf(http(403, { type: 'https://uniover.dev/problems/forbidden', title: 'x' })).kind,
    ).toBe('forbidden');
  });

  it('accepts an already-read problem and survives something that is not an HTTP error', () => {
    expect(pcFailureOf(new ApiProblem(503, 'agent-offline', 'x')).kind).toBe('offline');
    expect(pcFailureOf(new ApiProblem(503, 'agent-reconnecting', 'x')).kind).toBe('reconnecting');
    expect(pcFailureOf(new Error('boom')).kind).toBe('unknown');
  });
});
