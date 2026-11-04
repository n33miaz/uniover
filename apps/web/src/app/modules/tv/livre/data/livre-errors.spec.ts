import { HttpErrorResponse } from '@angular/common/http';
import { ApiProblem } from '../../../../core/auth/api-problem';
import {
  LIVRE_AGENT_CODES,
  describeLivreFailure,
  livreCodeMessage,
  livreCodeOf,
} from './livre-errors';

const PROBLEM = 'https://uniover.app/problems/';

function http(status: number, kind = '', extra: Record<string, unknown> = {}) {
  return new HttpErrorResponse({
    status,
    error: { type: kind ? PROBLEM + kind : undefined, title: kind, status, ...extra },
  });
}

describe('livreCodeMessage', () => {
  it('has a short sentence in pt-BR for every code the agent can return', () => {
    for (const code of LIVRE_AGENT_CODES) {
      const message = livreCodeMessage(code);
      expect(message, code).toBeTruthy();
      expect(message!.length, code).toBeLessThanOrEqual(110);
      // Só texto de gente: nunca o código técnico na frase.
      expect(message, code).not.toContain('_');
    }
  });

  it('groups the adb codes by what the person can do', () => {
    expect(livreCodeMessage('adb_unreachable')).toContain('ADB');
    expect(livreCodeMessage('adb_timeout')).toBe(livreCodeMessage('adb_unreachable'));
    expect(livreCodeMessage('adb_unauthorized')).toContain('Aceite');
    expect(livreCodeMessage('adb_qualquer_outro')).toContain('ADB');
  });

  it('does not know a code that is not one of the agent', () => {
    expect(livreCodeMessage('nada_disso')).toBeNull();
  });
});

describe('livreCodeOf', () => {
  it('reads agentError first, then the code of the problem', () => {
    expect(livreCodeOf(http(502, 'command-failed', { agentError: 'install_failed' }))).toBe(
      'install_failed',
    );
    expect(livreCodeOf(http(502, 'command-failed', { code: 'push_failed' }))).toBe('push_failed');
    expect(
      livreCodeOf(http(502, 'command-failed', { agentError: 'apk_invalid', code: 'outro' })),
    ).toBe('apk_invalid');
    expect(livreCodeOf(http(500))).toBeNull();
    expect(livreCodeOf(new Error('x'))).toBeNull();
  });

  it('reads the code of an ApiProblem that was already parsed', () => {
    expect(livreCodeOf(new ApiProblem(502, 'x', 't', 'verify_failed'))).toBe('verify_failed');
  });
});

describe('describeLivreFailure', () => {
  it('translates the code of the agent', () => {
    const failure = describeLivreFailure(
      http(502, 'command-failed', { agentError: 'install_failed' }),
    );
    expect(failure.message).toBe('A instalação não deu certo.');
    expect(failure.code).toBe('install_failed');
  });

  it('puts the TV without the capability first, whatever else came in the body', () => {
    const failure = describeLivreFailure(
      http(409, 'tv-livre-unsupported', { agentError: 'install_failed' }),
    );
    expect(failure.message).toBe('Esta TV não é compatível com o TV Livre.');
    expect(failure.code).toBe('unsupported');
  });

  it('does not mix up the 404 and 409 of the TV with the ones of the shortcuts', () => {
    expect(describeLivreFailure(http(404, 'not-found')).message).not.toContain('atalho');
    expect(describeLivreFailure(http(409, 'conflict')).message).not.toContain('instalado na TV');
    expect(describeLivreFailure(http(409, 'conflict')).message).toContain('ocupada');
  });

  it('explains a photo that is too big or is not a JPEG', () => {
    expect(describeLivreFailure(http(413, 'payload-too-large')).message).toContain('grande demais');
    expect(describeLivreFailure(http(415, 'unsupported-media-type')).message).toContain('JPEG');
  });

  it('says a timeout may have finished, and points to Atualizar', () => {
    const message = describeLivreFailure(http(504, 'agent-timeout')).message;
    expect(message).toContain('pode ter terminado');
    expect(message).toContain('Atualizar');
  });

  it('leaves the rest (network, session, permission, agent off) to the texts of the TV', () => {
    expect(describeLivreFailure(http(0)).message).toContain('Sem conexão');
    expect(describeLivreFailure(http(503, 'agent-offline')).message).toContain('agente da TV');
    expect(describeLivreFailure(http(403, 'forbidden')).message).toContain('permissão');
    expect(describeLivreFailure(new Error('x')).message).toContain('Não foi possível');
  });
});
