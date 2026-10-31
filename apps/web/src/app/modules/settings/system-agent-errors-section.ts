import { Component, effect, inject, signal, untracked } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import {
  AgentDiagnostic,
  AgentDiagnostics,
  countLabel,
  kindLabel,
  severityLabel,
  timeAgo,
} from './agent-diagnostics';
import { SettingsGlyph, SettingsGlyphName } from './settings-glyph';
import { SystemApi } from './system-api';

/**
 * Sistema > Erros dos Agentes: o que os próprios computadores contaram sobre si (queda, tarefa que falhou, reparo,
 * atualização recusada), dos últimos dias. É leitura: a API guarda por pouco tempo e já recebe o texto sem dados pessoais.
 * Só carrega para o administrador, como as outras seções de Sistema.
 */
@Component({
  selector: 'app-system-agent-errors-section',
  imports: [SettingsGlyph],
  templateUrl: './system-agent-errors-section.html',
  styleUrl: './system-agent-errors-section.css',
})
export class SystemAgentErrorsSection {
  private readonly api = inject(SystemApi);
  private readonly session = inject(SessionState);

  protected readonly diagnostics = signal<AgentDiagnostics | null>(null);
  protected readonly failed = signal(false);
  /** O instante da leitura: o "há X" de todas as linhas parte dele e não muda a cada ciclo de renderização. */
  private readonly readAt = signal(Date.now());

  constructor() {
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.diagnostics()) === null &&
        !untracked(() => this.failed())
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected async load(): Promise<void> {
    this.failed.set(false);
    try {
      const read = await this.api.agentDiagnostics();
      this.readAt.set(Date.now());
      this.diagnostics.set(read);
    } catch {
      this.failed.set(true);
    }
  }

  protected title(event: AgentDiagnostic): string {
    return kindLabel(event.kind);
  }

  protected severity(event: AgentDiagnostic): string {
    return severityLabel(event.severity);
  }

  /** O desenho diz o que a cor sozinha não diria: círculo com "i" é informação, triângulo é aviso ou erro. */
  protected glyph(event: AgentDiagnostic): SettingsGlyphName {
    return event.severity === 'info' ? 'info' : 'alert';
  }

  protected where(event: AgentDiagnostic): string {
    return event.component ? `${event.agentName} · ${event.component}` : event.agentName;
  }

  protected when(event: AgentDiagnostic): string {
    const ago = timeAgo(event.at, this.readAt());
    return event.count > 1 ? `${ago} · ${countLabel(event.count)}` : ago;
  }
}
