import { Component, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import {
  auditActionLabel,
  describeTarget,
  formatWhen,
  outcomeView,
  OutcomeView,
} from './audit-labels';
import { SettingsGlyph } from './settings-glyph';
import { SystemApi } from './system-api';

/** Uma linha do histórico, já em palavras: o que foi feito (e em quê), por quem, quando e se deu certo. */
interface HistoryRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly who: string;
  readonly when: string;
  readonly outcome: OutcomeView;
}

/**
 * Histórico de uma TV (só do administrador): quem mandou o quê, quando e se deu certo, do mais novo para o mais antigo. Quem
 * usa a TV não tem esta tela, nenhum atalho para ela e nenhuma permissão que fale dela. A rota é de administrador e a API
 * também recusa qualquer outra conta.
 *
 * Os nomes das contas vêm da lista de pessoas (a trilha só guarda o id).
 */
@Component({
  selector: 'app-tv-history-page',
  imports: [LoadingSkeleton, SettingsGlyph],
  templateUrl: './tv-history.page.html',
  styleUrl: './tv-history.page.css',
})
export class TvHistoryPage {
  private readonly api = inject(SystemApi);
  private readonly auth = inject(AuthService);
  private readonly authApi = inject(AuthApi);
  private readonly session = inject(SessionState);
  private readonly route = inject(ActivatedRoute);

  protected readonly rows = signal<readonly HistoryRow[] | null>(null);
  protected readonly tvName = signal<string | null>(null);
  protected readonly failed = signal<'load' | 'missing' | null>(null);

  constructor() {
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.rows()) === null
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected async load(): Promise<void> {
    this.failed.set(null);
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.failed.set('missing');
      return;
    }
    try {
      const [tvs, guests, items] = await Promise.all([
        this.api.tvs(),
        this.auth.authorized((token) => this.authApi.guests(token)),
        this.api.tvHistory(id),
      ]);
      const tv = tvs.find((item) => item.id === id);
      if (!tv) {
        this.failed.set('missing');
        return;
      }
      this.tvName.set(tv.name);
      const people = new Map(guests.map((guest) => [guest.id, guest.displayName]));
      const me = this.session.user();
      if (me) people.set(me.id, me.displayName || $localize`:@@settings.tv-history.you:Você`);
      this.rows.set(
        items.map((item) => ({
          id: item.id,
          title: auditActionLabel(item.command),
          detail: describeTarget({
            action: item.command,
            target: item.detail,
            targetAccount: null,
          }),
          who:
            people.get(item.userId) ??
            $localize`:@@settings.tv-history.removed-account:Conta removida`,
          when: formatWhen(item.occurredAt),
          outcome: outcomeView(item.ok ? 'success' : 'failure'),
        })),
      );
    } catch (error) {
      // A API responde 404 a uma TV que não existe: é o mesmo caso de a TV não estar na lista.
      this.failed.set(
        error instanceof HttpErrorResponse && error.status === 404 ? 'missing' : 'load',
      );
    }
  }
}
