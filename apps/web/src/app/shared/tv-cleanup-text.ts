/**
 * Palavras da limpeza da TV, para quem mostra um relatório (o painel da TV e Sistema). O agente e a API só trocam
 * códigos estáveis (`media-in-use`, `automatic`); a tela nunca mostra o código.
 */

/** Por que uma limpeza foi pulada, em poucas palavras. */
export function cleanupReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'media-in-use':
    case 'app-in-use':
    case 'recent-command':
      return $localize`:@@shared.tv-cleanup.reason.in-use:TV em uso`;
    case 'app-closing-disabled':
      return $localize`:@@shared.tv-cleanup.reason.closing-off:fechar apps em segundo plano está desligado`;
    case 'model-unconfirmed':
      return $localize`:@@shared.tv-cleanup.reason.model:modelo não confirmado`;
    case 'memory-unavailable':
    case 'state-unavailable':
      return $localize`:@@shared.tv-cleanup.reason.unreadable:a TV não respondeu`;
    case 'cleanup_in_progress':
      return $localize`:@@shared.tv-cleanup.reason.busy:outra limpeza em andamento`;
    default:
      return $localize`:@@shared.tv-cleanup.reason.other:a TV não pôde ser limpa agora`;
  }
}

/** O tipo da limpeza: leve (com a TV em uso), profunda (ociosa) ou pedida à mão. */
export function cleanupKindText(kind: string): string {
  switch (kind) {
    case 'light':
      return $localize`:@@shared.tv-cleanup.kind.light:Leve`;
    case 'deep':
      return $localize`:@@shared.tv-cleanup.kind.deep:Profunda`;
    default:
      return $localize`:@@shared.tv-cleanup.kind.manual:Manual`;
  }
}

/** O que a limpeza fez, numa frase curta: apps fechados e memória liberada, ou o motivo de ter sido pulada. */
export function cleanupOutcomeText(report: {
  readonly result: string;
  readonly reason: string | null;
  readonly closedApps: number;
  readonly memoryBeforeMb: number | null;
  readonly memoryAfterMb: number | null;
}): string {
  if (report.result === 'skipped') {
    return $localize`:@@shared.tv-cleanup.skipped:Pulada: ${cleanupReasonText(report.reason)}:reason:`;
  }
  const freed =
    report.memoryBeforeMb !== null && report.memoryAfterMb !== null
      ? Math.max(0, report.memoryAfterMb - report.memoryBeforeMb)
      : null;
  const apps = report.closedApps;
  const closed =
    apps === 1
      ? $localize`:@@shared.tv-cleanup.closed-one:Fechou 1 app`
      : $localize`:@@shared.tv-cleanup.closed-many:Fechou ${apps}:apps: apps`;
  if (freed !== null && freed >= 20) {
    return apps > 0
      ? $localize`:@@shared.tv-cleanup.done-apps:${closed}:closed: e liberou ${freed}:mb: MB`
      : $localize`:@@shared.tv-cleanup.done-mb:Liberou ${freed}:mb: MB`;
  }
  return apps > 0 ? closed : $localize`:@@shared.tv-cleanup.done-nothing:Nada para fechar`;
}
