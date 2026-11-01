import {
  countLabel,
  kindLabel,
  readAgentDiagnostics,
  severityLabel,
  timeAgo,
} from './agent-diagnostics';

describe('agent diagnostics', () => {
  it('names every kind the agent sends in plain words', () => {
    expect(kindLabel('background.failed')).toBe('Tarefa de fundo falhou');
    expect(kindLabel('process.crashed')).toBe('O agente caiu');
    expect(kindLabel('process.unresponsive')).toBe('O agente travou e foi reiniciado');
    expect(kindLabel('repair.done')).toBe('Reparo feito');
    expect(kindLabel('repair.failed')).toBe('Reparo não funcionou');
    expect(kindLabel('check.failed')).toBe('Verificação falhou');
    expect(kindLabel('update.rejected')).toBe('Atualização recusada');
    expect(kindLabel('update.rolled_back')).toBe('Voltou para a versão anterior');
    expect(kindLabel('update.failed')).toBe('Atualização falhou');
    expect(kindLabel('startup.task_missing')).toBe('Início automático refeito');
    expect(kindLabel('agent.started')).toBe('Agente iniciado');
    expect(kindLabel('diagnostics.dropped')).toBe('Eventos descartados');
  });

  it('shows an unknown kind neutrally, with the raw text', () => {
    expect(kindLabel('future.thing')).toBe('Ocorrência (future.thing)');
  });

  it('labels the three severities', () => {
    expect(severityLabel('info')).toBe('Info');
    expect(severityLabel('warn')).toBe('Aviso');
    expect(severityLabel('error')).toBe('Erro');
  });

  it('says how long ago, rounding down and never in the future', () => {
    const now = new Date('2026-10-31T12:00:00Z').getTime();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(timeAgo(ago(30_000), now)).toBe('agora');
    expect(timeAgo(ago(-5 * 60_000), now)).toBe('agora');
    expect(timeAgo(ago(5 * 60_000 + 1000), now)).toBe('há 5 min');
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe('há 3 h');
    expect(timeAgo(ago(24 * 3_600_000), now)).toBe('há 1 dia');
    expect(timeAgo(ago(3 * 24 * 3_600_000), now)).toBe('há 3 dias');
  });

  it('counts repetitions', () => {
    expect(countLabel(3)).toBe('3 vezes');
  });

  it('normalizes what the API sends: numbers as text, a severity out of the contract, a missing component', () => {
    const read = readAgentDiagnostics({
      retentionDays: '7',
      items: [
        {
          id: '1',
          agentId: 'a',
          agentName: 'PC da sala',
          at: '2026-10-31T12:00:00Z',
          kind: 'repair.done',
          severity: 'fatal',
          component: null,
          detail: 'x',
          count: '3',
        },
      ],
    });
    expect(read.retentionDays).toBe(7);
    expect(read.items[0]).toMatchObject({ severity: 'warn', component: null, count: 3 });
  });
});
