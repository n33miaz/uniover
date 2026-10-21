import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { describeFailure } from './tv-errors';

const PROBLEM = 'https://uniover.app/problems/';

function http(
  status: number,
  kind = '',
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new HttpErrorResponse({
    status,
    headers: new HttpHeaders(headers),
    error: { type: kind ? PROBLEM + kind : undefined, title: kind, status, ...extra },
  });
}

describe('describeFailure', () => {
  it('maps 503 agent-offline to "agente desligado"', () => {
    const failure = describeFailure(http(503, 'agent-offline'));
    expect(failure.kind).toBe('agent-offline');
    expect(failure.message).toContain('agente da TV está desligado');
  });

  it('tells apart 503 agent-not-configured from agent-offline', () => {
    const failure = describeFailure(http(503, 'agent-not-configured'));
    expect(failure.kind).toBe('not-configured');
    expect(failure.message).toContain('Nenhum agente foi configurado');
  });

  it('maps 504 to "a TV não respondeu"', () => {
    const failure = describeFailure(http(504, 'agent-timeout'));
    expect(failure.kind).toBe('timeout');
    expect(failure.message).toContain('A TV não respondeu a tempo');
  });

  it('maps 502 to the message of the agent code', () => {
    const unreachable = http(502, 'command-failed', { agentError: 'TV_UNREACHABLE' });
    expect(describeFailure(unreachable).message).toContain('A TV não respondeu ao controle');
    const other = http(502, 'command-failed', { agentError: 'OUTRO_ERRO' });
    expect(describeFailure(other).message).toContain('OUTRO_ERRO');
    expect(describeFailure(http(502, 'command-failed')).message).toBe(
      'A TV não executou o comando.',
    );
  });

  it('maps the ADB codes of the agent to one clear message', () => {
    for (const code of ['adb_unreachable', 'adb_unavailable', 'adb_timeout']) {
      const failure = describeFailure(http(502, 'command-failed', { agentError: code }));
      expect(failure.kind).toBe('command-failed');
      expect(failure.message).toBe(
        'A TV não respondeu pelo ADB agora. Tente de novo com a TV ligada.',
      );
    }
    const unauthorized = describeFailure(
      http(502, 'command-failed', { agentError: 'adb_unauthorized' }),
    );
    expect(unauthorized.message).toContain('Aceite o aviso na tela da TV');
    const missing = describeFailure(
      http(502, 'command-failed', { agentError: 'cleanup_report_missing' }),
    );
    expect(missing.message).toContain('não deu para confirmar o que foi limpo');
  });

  it('a timeout while cleaning admits the TV may have finished', () => {
    const failure = describeFailure(http(504, 'agent-timeout'), 'cleanup');
    expect(failure.kind).toBe('timeout');
    expect(failure.message).toContain('a TV pode ter terminado');
    expect(describeFailure(http(504, 'agent-timeout')).message).toBe(
      'A TV não respondeu a tempo. Tente de novo.',
    );
  });

  it('tells a cleanup already running (409) from an app that left the TV (409)', () => {
    const busy = describeFailure(http(409, 'cleanup-in-progress'));
    expect(busy.kind).toBe('cleanup-busy');
    expect(busy.message).toBe('Já há uma limpeza da TV em andamento. Aguarde ela terminar.');
    expect(describeFailure(http(409, 'shortcut-disabled')).kind).toBe('shortcut-disabled');
  });

  it('maps 429 with the Retry-After seconds, or without them', () => {
    const withWait = describeFailure(http(429, 'rate-limited', {}, { 'Retry-After': '7' }));
    expect(withWait.kind).toBe('rate-limited');
    expect(withWait.message).toBe('Comandos demais em pouco tempo. Aguarde 7 s.');
    expect(withWait.retryAfterSeconds).toBe(7);
    const without = describeFailure(http(429, 'rate-limited'));
    expect(without.message).toBe('Comandos demais em pouco tempo. Aguarde um pouco.');
    expect(without.retryAfterSeconds).toBeNull();
  });

  it('says plainly that the account lacks the permission (403), not that the TV failed', () => {
    const failure = describeFailure(http(403, 'forbidden'));
    expect(failure.kind).toBe('forbidden');
    expect(failure.message).toBe('Você não tem permissão para fazer isso na TV.');
  });

  it('maps the remaining statuses', () => {
    expect(describeFailure(http(400, 'validation-failed')).kind).toBe('invalid');
    expect(describeFailure(http(401)).kind).toBe('session');
    expect(describeFailure(http(404, 'not-found')).kind).toBe('not-found');
    expect(describeFailure(http(409, 'shortcut-disabled')).kind).toBe('shortcut-disabled');
    expect(describeFailure(http(500, 'internal-error')).kind).toBe('unknown');
  });

  it('maps a call without answer to a network failure', () => {
    const failure = describeFailure(new HttpErrorResponse({ status: 0 }));
    expect(failure.kind).toBe('network');
  });

  it('never throws on what is not an HTTP error', () => {
    expect(describeFailure(new Error('x')).kind).toBe('unknown');
    expect(describeFailure(undefined).kind).toBe('unknown');
  });
});
