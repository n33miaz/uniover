import type { OutboxItem } from '../../../core/offline-queue/offline-db';

/** O que um item da fila é, em palavras de quem usa o app: o tipo ("Rotina") e, quando há, o nome ("Treino A"). */
export interface IssueDescription {
  readonly kind: string;
  readonly name: string | null;
  /** O item apaga o registro (lápide), em vez de gravá-lo. */
  readonly deleting: boolean;
}

interface KindLabels {
  readonly save: () => string;
  readonly remove: () => string;
}

const KIND_LABELS = {
  exerciseStep: {
    save: () => $localize`:@@training.issues.kind.step:Salto de carga`,
    remove: () => $localize`:@@training.issues.kind.step:Salto de carga`,
  },
  exercise: {
    save: () => $localize`:@@training.issues.kind.exercise:Exercício`,
    remove: () => $localize`:@@training.issues.kind.exercise-delete:Apagar exercício`,
  },
  routine: {
    save: () => $localize`:@@training.issues.kind.routine:Rotina`,
    remove: () => $localize`:@@training.issues.kind.routine-delete:Apagar rotina`,
  },
  set: {
    save: () => $localize`:@@training.issues.kind.set:Série`,
    remove: () => $localize`:@@training.issues.kind.set-delete:Apagar série`,
  },
  session: {
    save: () => $localize`:@@training.issues.kind.session:Treino`,
    remove: () => $localize`:@@training.issues.kind.session-delete:Apagar treino`,
  },
  goal: {
    save: () => $localize`:@@training.issues.kind.goal:Meta`,
    remove: () => $localize`:@@training.issues.kind.goal-delete:Apagar meta`,
  },
  other: {
    save: () => $localize`:@@training.issues.kind.other:Alteração`,
    remove: () => $localize`:@@training.issues.kind.other:Alteração`,
  },
} as const satisfies Record<string, KindLabels>;

type KindKey = keyof typeof KIND_LABELS;

/** O recurso que o caminho da API nomeia (`/api/v1/training/<recurso>/...`). */
function kindOf(url: string): KindKey {
  const path = url.split('?')[0];
  const segments = path.split('/').filter(Boolean);
  const at = segments.indexOf('training');
  const rest = at < 0 ? [] : segments.slice(at + 1);
  switch (rest[0]) {
    case 'exercises':
      return rest[2] === 'step' ? 'exerciseStep' : 'exercise';
    case 'routines':
      return 'routine';
    case 'sessions':
      return rest[2] === 'sets' ? 'set' : 'session';
    case 'goals':
      return 'goal';
    default:
      return 'other';
  }
}

function bodyOf(body: unknown): { name?: unknown; deleted?: unknown } {
  return typeof body === 'object' && body !== null ? body : {};
}

/** Descreve um item recusado da fila com o tipo da escrita e o nome do registro (quando o corpo o traz). */
export function describeIssue(item: Pick<OutboxItem, 'url' | 'body'>): IssueDescription {
  const key = kindOf(item.url);
  const body = bodyOf(item.body);
  const deleting = body.deleted === true;
  const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : null;
  return {
    kind: deleting ? KIND_LABELS[key].remove() : KIND_LABELS[key].save(),
    name,
    deleting,
  };
}

/** O motivo da recusa em uma frase: o tipo do problema, quando é um que o app conhece, e o código HTTP. */
export function explainFailure(lastError: string | null): string {
  const match = /^http-(\d{3})(?::(.+))?$/.exec(lastError ?? '');
  const status = match?.[1];
  const problem = match?.[2];
  if (problem === 'client-clock-ahead') {
    return $localize`:@@training.issues.why.clock:O relógio deste aparelho está adiantado demais para o servidor aceitar.`;
  }
  if (problem === 'catalog-row-readonly') {
    return $localize`:@@training.issues.why.readonly:Exercício do catálogo não pode ser alterado.`;
  }
  if (status === '404') {
    return $localize`:@@training.issues.why.missing:O servidor não encontrou o registro (404).`;
  }
  if (status) {
    return $localize`:@@training.issues.why.refused:O servidor recusou esta alteração (código ${status}:status:).`;
  }
  return $localize`:@@training.issues.why.unknown:O servidor recusou esta alteração.`;
}
