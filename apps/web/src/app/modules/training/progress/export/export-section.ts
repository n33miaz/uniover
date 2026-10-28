import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ExportService } from '../../data/export/export-service';
import { GoalRepository } from '../../data/goals/goal-repository';
import { ProgressRepository, type WeekSummary } from '../../data/progress/progress-repository';
import { SessionRepository } from '../../data/sessions/session-repository';
import { ProgressGlyph, type ProgressGlyphName } from '../progress-glyph';
import { ProgressSection } from '../progress-section';

export type ExportAction = 'json' | 'csv' | 'share';

/** O estado de uma ação: nada feito, trabalhando, feita (com o que dizer) ou com problema (com o motivo). */
export interface ActionState {
  readonly kind: 'idle' | 'busy' | 'done' | 'error';
  readonly text: string;
}

const IDLE: ActionState = { kind: 'idle', text: '' };

/**
 * Exportar e compartilhar: o JSON com tudo, o CSV das séries (abre em planilha) e o resumo da semana em texto. É o seguro
 * extra contra o navegador apagar os dados do site. Cada ação diz o que aconteceu (preparando, pronto, ou o motivo de não ter
 * dado certo): nunca fica em silêncio. O baixar arquivo e o compartilhar dependem do aparelho (o iPhone instalado como
 * app ainda não foi medido), por isso o texto diz o que o app sabe, e não promete o que não conseguiu confirmar.
 */
@Component({
  selector: 'app-progress-export',
  imports: [ProgressSection, ProgressGlyph],
  templateUrl: './export-section.html',
  styleUrl: './export-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressExport {
  private readonly exports = inject(ExportService);
  private readonly progress = inject(ProgressRepository);
  private readonly goals = inject(GoalRepository);
  private readonly sessions = inject(SessionRepository);
  private readonly doc = inject(DOCUMENT);

  protected readonly heading = $localize`:@@training.progress.export.title:Exportar e Compartilhar`;
  protected readonly summary = $localize`:@@training.progress.export.summary:JSON, CSV e resumo da semana`;
  protected readonly open = signal(false);

  private readonly states = signal<Record<ExportAction, ActionState>>({
    json: IDLE,
    csv: IDLE,
    share: IDLE,
  });
  /**
   * O resumo da semana já lido: o compartilhar do sistema só aceita ser chamado logo depois do toque, sem esperar leitura.
   * Vale enquanto nada mudou no aparelho (`key`): se chegaram treinos ou metas depois da leitura, o toque lê de novo em vez
   * de compartilhar um resumo velho.
   */
  private week: { key: string; summary: WeekSummary; goal: number | null } | null = null;

  protected readonly rows = computed<
    readonly {
      readonly action: ExportAction;
      readonly glyph: ProgressGlyphName;
      readonly title: string;
      readonly sub: string;
      readonly state: ActionState;
    }[]
  >(() => {
    const states = this.states();
    return [
      {
        action: 'json',
        glyph: 'download',
        title: $localize`:@@training.progress.export.json:Exportar Tudo (JSON)`,
        sub: $localize`:@@training.progress.export.json-sub:Treinos, séries, rotinas e metas`,
        state: states.json,
      },
      {
        action: 'csv',
        glyph: 'bars',
        title: $localize`:@@training.progress.export.csv:Exportar Séries (CSV)`,
        sub: $localize`:@@training.progress.export.csv-sub:Abre em planilha`,
        state: states.csv,
      },
      {
        action: 'share',
        glyph: 'share',
        title: $localize`:@@training.progress.export.share:Compartilhar Resumo da Semana`,
        sub: $localize`:@@training.progress.export.share-sub:Texto com volume e recordes`,
        state: states.share,
      },
    ];
  });

  constructor() {
    // Deixa o resumo pronto enquanto a seção está aberta (e quando chegam treinos ou metas novos).
    effect(() => {
      if (!this.open()) return;
      this.sessions.revision();
      this.goals.revision();
      untracked(() => void this.prepareWeek());
    });
  }

  protected async run(action: ExportAction): Promise<void> {
    if (this.states()[action].kind === 'busy') return;
    if (action === 'share') return this.share();

    if (!this.canDownload()) {
      this.set(action, {
        kind: 'error',
        text: $localize`:@@training.progress.export.no-download:Este aparelho não baixa arquivos por aqui. Tente abrir o app no navegador.`,
      });
      return;
    }
    this.set(action, {
      kind: 'busy',
      text: $localize`:@@training.progress.export.busy:Preparando o arquivo…`,
    });
    try {
      const name =
        action === 'json'
          ? await this.exports.downloadJson()
          : await this.exports.downloadSetsCsv();
      this.set(action, {
        kind: 'done',
        text: $localize`:@@training.progress.export.done:Arquivo gerado: ${name}:name:. Se o download não aparecer neste aparelho, tente de novo pelo navegador.`,
      });
    } catch {
      this.set(action, {
        kind: 'error',
        text: $localize`:@@training.progress.export.failed:Não foi possível gerar o arquivo agora. Tente de novo.`,
      });
    }
  }

  private async share(): Promise<void> {
    // O compartilhar do sistema precisa ser chamado logo depois do toque: com o resumo já lido, nada espera antes dele.
    const ready = this.week?.key === this.dataKey() ? this.week : await this.prepareWeek();
    this.set('share', {
      kind: 'busy',
      text: $localize`:@@training.progress.export.share-busy:Abrindo o compartilhar…`,
    });
    try {
      const outcome = await this.exports.shareWeekSummary(ready.summary, ready.goal);
      switch (outcome) {
        case 'shared':
          this.set('share', {
            kind: 'done',
            text: $localize`:@@training.progress.export.shared:Resumo enviado ao compartilhar do aparelho.`,
          });
          return;
        case 'copied':
          this.set('share', {
            kind: 'done',
            text: $localize`:@@training.progress.export.copied:Este aparelho não abre o compartilhar: o resumo foi copiado, é só colar onde quiser.`,
          });
          return;
        case 'cancelled':
          this.set('share', IDLE);
          return;
        case 'unsupported':
          this.set('share', {
            kind: 'error',
            text: $localize`:@@training.progress.export.share-unsupported:Este aparelho não consegue compartilhar nem copiar o texto. Use o JSON ou o CSV.`,
          });
          return;
      }
    } catch {
      this.set('share', {
        kind: 'error',
        text: $localize`:@@training.progress.export.share-failed:Não foi possível compartilhar agora. Tente de novo.`,
      });
    }
  }

  /** Sobe a cada treino, série ou meta gravados ou chegados neste aparelho. */
  private dataKey(): string {
    return `${this.sessions.revision()}:${this.goals.revision()}`;
  }

  private async prepareWeek(): Promise<{ summary: WeekSummary; goal: number | null }> {
    const key = this.dataKey();
    const [summary, goal] = await Promise.all([
      this.progress.weekSummary(),
      this.goals.value('weekly_sessions'),
    ]);
    this.week = { key, summary, goal };
    return this.week;
  }

  private canDownload(): boolean {
    const win = this.doc.defaultView;
    return typeof Blob !== 'undefined' && typeof win?.URL?.createObjectURL === 'function';
  }

  private set(action: ExportAction, state: ActionState): void {
    this.states.update((states) => ({ ...states, [action]: state }));
  }
}
