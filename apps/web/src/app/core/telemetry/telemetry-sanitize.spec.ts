import {
  ROUTE_MAX,
  errorName,
  normalizeApiPath,
  normalizeRoute,
  safeCode,
  safeTrace,
  safeVersion,
} from './telemetry-sanitize';

describe('normalizeRoute', () => {
  it('drops query string and fragment', () => {
    expect(normalizeRoute('/tv?token=abc&q=senha#topo')).toBe('/tv');
    expect(normalizeRoute('/treino/sessao#x')).toBe('/treino/sessao');
  });

  it('gives back a model of the allowed list: where the model has a parameter the value becomes :id', () => {
    expect(normalizeRoute('/treino/rotinas/0192f1e4-7a3b-7c11-8f2e-5d6a7b8c9d0e')).toBe(
      '/treino/rotinas/:id',
    );
    expect(normalizeRoute('/treino/corpo/avaliacoes/abc/editar')).toBe(
      '/treino/corpo/avaliacoes/:id/editar',
    );
    expect(normalizeRoute('/ajustes/tv/sala/historico')).toBe('/ajustes/tv/:id/historico');
  });

  it('never decides by the shape of the text: a short safe-looking word where the model has no parameter is unknown', () => {
    // Apelido, data, texto digitado: curtos e de letras seguras, mas nenhum modelo tem parâmetro ali.
    expect(normalizeRoute('/tv/minha-senha')).toBe('/tv/:x');
    expect(normalizeRoute('/treino/sessao/2026-11-10')).toBe('/treino/sessao/:x');
    expect(normalizeRoute('/treino/apelido-do-joao')).toBe('/treino/:x');
  });

  it('a parameter slot also swallows free text as :id, never the text itself', () => {
    expect(normalizeRoute('/treino/rotinas/minha-rotina-secreta')).toBe('/treino/rotinas/:id');
  });

  it('an unknown segment becomes the fixed marker and the rest of the path is dropped', () => {
    expect(normalizeRoute('/segredo/outro/mais')).toBe('/:x');
    expect(normalizeRoute('/treino/rotinas/abc/oculto/mais')).toBe('/treino/rotinas/:id/:x');
  });

  it('keeps only the path of an absolute address', () => {
    expect(normalizeRoute('https://uniover.onrender.com/treino/progresso?x=1')).toBe(
      '/treino/progresso',
    );
  });

  it('gives / for empty or unreadable input and respects the length cap', () => {
    expect(normalizeRoute(null)).toBe('/');
    expect(normalizeRoute('')).toBe('/');
    expect(normalizeRoute('/')).toBe('/');
    expect(normalizeRoute('/' + 'a'.repeat(500)).length).toBeLessThanOrEqual(ROUTE_MAX);
  });
});

describe('normalizeApiPath', () => {
  it('maps an API call to its model, with the id slots as :id', () => {
    expect(
      normalizeApiPath('/api/v1/tv/shortcuts/0192f1e4-7a3b-7c11-8f2e-5d6a7b8c9d0e/launch?x=1'),
    ).toBe('/api/v1/tv/shortcuts/:id/launch');
    expect(normalizeApiPath('/api/v1/training/sessions/abc/sets/def')).toBe(
      '/api/v1/training/sessions/:id/sets/:id',
    );
    expect(normalizeApiPath('/api/v1/pc/click')).toBe('/api/v1/pc/click');
  });

  it('a path the contract does not know becomes :x, and never carries the text', () => {
    expect(normalizeApiPath('/api/v1/pc/text/minha-senha')).toBe('/api/v1/pc/text/:x');
    expect(normalizeApiPath('/api/v2/qualquer')).toBe('/api/:x');
  });
});

describe('safe values', () => {
  it('accepts short codes and refuses anything else', () => {
    expect(safeCode('TypeError')).toBe('TypeError');
    expect(safeCode('http_503')).toBe('http_503');
    expect(safeCode('rate-limited')).toBe('rate-limited');
    expect(safeCode('has space')).toBeNull();
    expect(safeCode('a'.repeat(49))).toBeNull();
    expect(safeCode('<script>')).toBeNull();
    expect(safeCode(42)).toBeNull();
    expect(safeCode(undefined)).toBeNull();
  });

  it('accepts a trace id with the shape of an identifier only', () => {
    expect(safeTrace('4bf92f3577b34da6a3ce929d0e0e4736')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(safeTrace('curto')).toBeNull();
    expect(safeTrace('com espaço no meio do rastro')).toBeNull();
    expect(safeTrace(null)).toBeNull();
  });

  it('accepts a version only', () => {
    expect(safeVersion('0.54.0')).toBe('0.54.0');
    expect(safeVersion('1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(safeVersion('não é versão')).toBeNull();
  });

  it('takes only the class name of an error, never the message', () => {
    expect(errorName(new TypeError('a senha 1234 do usuário'))).toBe('TypeError');
    expect(errorName('texto solto com dado')).toBe('unknown');
    expect(errorName(null)).toBe('unknown');
    class Estranho extends Error {
      constructor() {
        super('x');
        this.name = 'nome com espaço e dado';
      }
    }
    expect(errorName(new Estranho())).toBe('Error');
  });
});
