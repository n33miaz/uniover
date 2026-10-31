import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { IssueDescription, describeIssue, explainFailure } from './sync-issue-text';
import { TrainingSheet } from './training-sheet';

interface IssueRow {
  readonly id: string;
  readonly description: IssueDescription;
  readonly reason: string;
  /** O nome que o leitor de tela lê nos botões da linha, para "Tentar de novo" não se repetir igual. */
  readonly subject: string;
}

/**
 * Folha com o que o servidor recusou de vez (itens `failed` da fila). Cada item pode ser reenviado ou descartado; descartar
 * perde o dado, então só vale depois de uma confirmação ali mesmo: só quem usa o app decide descartar (nada aqui, nem um
 * erro, descarta sozinho). Quando o último item sai da fila a folha desce sozinha.
 */
@Component({
  selector: 'app-sync-issues-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading" (closed)="closed.emit()">
      <p class="intro" i18n="@@training.issues.intro">
        O servidor não aceitou estas alterações. Elas continuam guardadas neste aparelho até você
        decidir.
      </p>
      <ul class="list ui-group ui-plain">
        @for (row of rows(); track row.id) {
          <li class="issue">
            <p class="what">
              <span class="kind">{{ row.description.kind }}</span>
              @if (row.description.name; as name) {
                <span class="name">“{{ name }}”</span>
              }
            </p>
            <p class="why">{{ row.reason }}</p>
            @if (confirming() === row.id) {
              <div class="ui-notice bad confirm" role="alert">
                <span class="confirm-text">
                  <span i18n="@@training.issues.discard-ask"
                    >Descartar esta alteração? Ela será perdida e não volta.</span
                  >
                  <span class="pair">
                    <button
                      type="button"
                      class="danger ui-btn"
                      [attr.aria-label]="discardLabel(row)"
                      (click)="discard(row)"
                    >
                      <span i18n="@@training.issues.discard">Descartar</span>
                    </button>
                    <button type="button" class="secondary ui-btn" (click)="keep()">
                      <span i18n="@@training.issues.keep">Manter</span>
                    </button>
                  </span>
                </span>
              </div>
            } @else {
              <div class="pair">
                <button
                  type="button"
                  class="secondary ui-btn"
                  [attr.aria-label]="retryLabel(row)"
                  (click)="retry(row)"
                >
                  <span i18n="@@training.issues.retry">Tentar de Novo</span>
                </button>
                <button
                  type="button"
                  class="destructive secondary ui-btn"
                  [attr.aria-label]="discardLabel(row)"
                  (click)="askDiscard(row)"
                >
                  <span i18n="@@training.issues.discard">Descartar</span>
                </button>
              </div>
            }
          </li>
        }
      </ul>
    </app-training-sheet>
  `,
  styleUrl: './sync-issues-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SyncIssuesSheet {
  private readonly queue = inject(OfflineQueue);
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.issues.title:Alterações com Erro`;
  protected readonly rows = signal<readonly IssueRow[]>([]);
  protected readonly confirming = signal<string | null>(null);

  constructor() {
    effect(() => {
      // Qualquer mudança da fila (reenvio aceito, item recusado, descarte) relê a lista.
      this.queue.failedCount();
      this.queue.pendingCount();
      untracked(() => void this.load());
    });
  }

  protected retryLabel(row: IssueRow): string {
    return $localize`:@@training.issues.retry-label:Tentar de novo: ${row.subject}:subject:`;
  }

  protected discardLabel(row: IssueRow): string {
    return $localize`:@@training.issues.discard-label:Descartar: ${row.subject}:subject:`;
  }

  protected async retry(row: IssueRow): Promise<void> {
    await this.queue.retry(row.id);
  }

  protected askDiscard(row: IssueRow): void {
    this.confirming.set(row.id);
  }

  protected keep(): void {
    this.confirming.set(null);
  }

  protected async discard(row: IssueRow): Promise<void> {
    this.confirming.set(null);
    await this.queue.discard(row.id);
  }

  private async load(): Promise<void> {
    const items = await this.queue.items();
    const failed = items
      .filter((item) => item.status === 'failed')
      .map((item): IssueRow => {
        const description = describeIssue(item);
        return {
          id: item.id,
          description,
          reason: explainFailure(item.lastError),
          subject: description.name
            ? `${description.kind} “${description.name}”`
            : description.kind,
        };
      });
    this.rows.set(failed);
    // Sem item com erro a folha não tem o que mostrar: desce sozinha.
    if (failed.length === 0) this.sheet().close();
  }
}
