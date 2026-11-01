import { cleanupKindText, cleanupOutcomeText, cleanupReasonText } from './tv-cleanup-text';

describe('tv cleanup text', () => {
  it('says "TV em uso" for every reason that means someone may be watching', () => {
    for (const reason of ['media-in-use', 'app-in-use', 'recent-command']) {
      expect(cleanupReasonText(reason)).toBe('TV em uso');
    }
  });

  it('gives every other known reason its own words, and never shows the code', () => {
    expect(cleanupReasonText('app-closing-disabled')).toContain('desligado');
    expect(cleanupReasonText('model-unconfirmed')).toBe('modelo não confirmado');
    expect(cleanupReasonText('memory-unavailable')).toBe('a TV não respondeu');
    expect(cleanupReasonText('cleanup_in_progress')).toBe('outra limpeza em andamento');
    expect(cleanupReasonText('automatic-only')).toContain('sozinha');
    expect(cleanupReasonText('permission-required')).toContain('permitir');
    expect(cleanupReasonText('foreground-unverifiable')).toContain('sem certeza');
    expect(cleanupReasonText('algo-novo')).not.toContain('algo-novo');
    expect(cleanupReasonText(null)).not.toBe('');
  });

  it('names the kinds', () => {
    expect([cleanupKindText('light'), cleanupKindText('deep'), cleanupKindText('manual')]).toEqual([
      'Leve',
      'Profunda',
      'Manual',
    ]);
  });

  it('describes what a finished cleanup did without promising a number it did not measure', () => {
    const base = {
      result: 'completed',
      reason: null,
      closedApps: 0,
      memoryBeforeMb: null,
      memoryAfterMb: null,
    };
    expect(cleanupOutcomeText(base)).toBe('Nada para fechar');
    expect(cleanupOutcomeText({ ...base, closedApps: 2 })).toBe('Fechou 2 apps');
    expect(cleanupOutcomeText({ ...base, closedApps: 1 })).toBe('Fechou 1 app');
    expect(cleanupOutcomeText({ ...base, memoryBeforeMb: 200, memoryAfterMb: 300 })).toBe(
      'Liberou 100 MB',
    );
    expect(
      cleanupOutcomeText({ ...base, closedApps: 3, memoryBeforeMb: 200, memoryAfterMb: 300 }),
    ).toBe('Fechou 3 apps e liberou 100 MB');
    expect(cleanupOutcomeText({ ...base, result: 'skipped', reason: 'media-in-use' })).toBe(
      'Pulada: TV em uso',
    );
  });
});
