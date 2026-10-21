import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import {
  ApiProblem,
  isPermissionDenied,
  isStepUpRequired,
  networkProblem,
  parseRetryAfter,
  problemFrom,
  problemOf,
} from './api-problem';

describe('problemFrom', () => {
  it('reads the last segment of the type URL as kind', () => {
    const problem = problemFrom(
      429,
      { type: 'https://uniover.app/problems/login-locked', title: 'Bloqueada' },
      '120',
    );
    expect(problem.kind).toBe('login-locked');
    expect(problem.status).toBe(429);
    expect(problem.message).toBe('Bloqueada');
    expect(problem.retryAfterSeconds).toBe(120);
  });

  it('reads code and action from the step-up extensions', () => {
    const problem = problemFrom(
      403,
      {
        type: 'https://uniover.app/problems/step-up-required',
        code: 'step_up_required',
        action: 'identity.passkey-remove',
      },
      null,
    );
    expect(problem.code).toBe('step_up_required');
    expect(problem.action).toBe('identity.passkey-remove');
    expect(isStepUpRequired(problem)).toBe(true);
  });

  it('keeps the field errors of a validation problem', () => {
    const problem = problemFrom(
      400,
      { errors: { email: ['Informe um e-mail válido.'], x: 3 } },
      null,
    );
    expect(problem.fieldErrors).toEqual({ email: ['Informe um e-mail válido.'] });
  });

  it('survives a body that is not an object', () => {
    expect(problemFrom(502, null, null).kind).toBe('');
    expect(problemFrom(502, 'texto', null).message).toBe('HTTP 502');
  });
});

describe('isStepUpRequired', () => {
  it('does not treat other 403s as a step-up request', () => {
    expect(isStepUpRequired(new ApiProblem(403, 'invalid-password', 'x'))).toBe(false);
    expect(isStepUpRequired(new ApiProblem(403, 'step-up-failed', 'x'))).toBe(false);
    expect(isStepUpRequired(new ApiProblem(401, 'step-up-required', 'x'))).toBe(false);
  });
});

describe('isPermissionDenied', () => {
  it('is the plain 403 of an access policy, as the API types it', () => {
    const denied = problemFrom(
      403,
      { type: 'https://uniover.app/problems/forbidden', title: 'Sem permissão.' },
      null,
    );
    expect(isPermissionDenied(denied)).toBe(true);
  });

  it('leaves out the passkey and the other 403s that have a type of their own', () => {
    for (const kind of [
      'step-up-required',
      'step-up-failed',
      'invalid-password',
      'catalog-row-readonly',
      'pairing-denied',
    ]) {
      expect(isPermissionDenied(new ApiProblem(403, kind, 'x'))).toBe(false);
    }
    expect(isPermissionDenied(new ApiProblem(403, 'x', 'x', 'step_up_required', 'a.b'))).toBe(
      false,
    );
  });

  it('leaves out every status other than 403', () => {
    expect(isPermissionDenied(new ApiProblem(401, 'forbidden', 'x'))).toBe(false);
    expect(isPermissionDenied(new ApiProblem(404, 'not-found', 'x'))).toBe(false);
    expect(isPermissionDenied(networkProblem())).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('accepts seconds, rounds up and keeps a minimum of 1', () => {
    expect(parseRetryAfter('60')).toBe(60);
    expect(parseRetryAfter('0.2')).toBe(1);
    expect(parseRetryAfter('0')).toBe(1);
  });

  it('accepts an HTTP date', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(parseRetryAfter('Sun, 18 Oct 2026 12:01:00 GMT', now)).toBe(60);
  });

  it('returns null when absent or unreadable', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('em breve')).toBeNull();
  });
});

describe('problemOf', () => {
  it('passes an ApiProblem through', () => {
    const problem = networkProblem();
    expect(problemOf(problem)).toBe(problem);
    expect(problem.isNetwork).toBe(true);
  });

  it('reads an HttpErrorResponse, including the Retry-After header', () => {
    const error = new HttpErrorResponse({
      status: 429,
      headers: new HttpHeaders({ 'Retry-After': '30' }),
      error: { type: 'https://uniover.app/problems/rate-limited' },
    });
    const problem = problemOf(error);
    expect(problem?.kind).toBe('rate-limited');
    expect(problem?.retryAfterSeconds).toBe(30);
  });

  it('maps status 0 to a network problem and ignores unrelated errors', () => {
    expect(problemOf(new HttpErrorResponse({ status: 0 }))?.isNetwork).toBe(true);
    expect(problemOf(new Error('x'))).toBeNull();
  });
});
