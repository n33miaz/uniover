import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { AuthApi, LoginSession } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';

/** Sessões do dono ou da pessoa escolhida. O servidor decide a propriedade de cada família. */
@Component({
  selector: 'app-sessions-section',
  templateUrl: './sessions-section.html',
  styleUrl: './sessions-section.css',
})
export class SessionsSection {
  readonly guestId = input<string | null>(null);
  readonly guestName = input<string | null>(null);

  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);

  protected readonly sessions = signal<readonly LoginSession[] | null>(null);
  protected readonly failed = signal(false);
  protected readonly busy = signal(false);
  protected readonly confirmingId = signal<string | null>(null);
  protected readonly confirmingOthers = signal(false);
  protected readonly note = signal<string | null>(null);
  protected readonly hasOthers = computed(() =>
    (this.sessions() ?? []).some((item) => !item.isCurrent),
  );
  protected readonly dateFormat = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  constructor() {
    effect(() => {
      const guestId = this.guestId();
      if (
        this.session.status() === 'authenticated' &&
        (guestId === null || this.session.role() === 'owner')
      ) {
        untracked(() => void this.load(guestId));
      }
    });
  }

  protected title(): string {
    const name = this.guestName();
    return name
      ? $localize`:@@settings.sessions.guest-title:Sessões de ${name}:name:`
      : $localize`:@@settings.sessions.title:Sessões de Acesso`;
  }

  protected device(item: LoginSession): string {
    const agent = item.userAgent ?? '';
    const browser = /Edg\/|EdgiOS\//.test(agent)
      ? 'Edge'
      : /Firefox\/|FxiOS\//.test(agent)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : $localize`:@@settings.sessions.browser:Navegador`;
    const system = /iPhone|iPad/.test(agent)
      ? 'iPhone/iPad'
      : /Android/.test(agent)
        ? 'Android'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(agent)
            ? 'Mac'
            : /Linux/.test(agent)
              ? 'Linux'
              : null;
    return system ? `${browser} · ${system}` : browser;
  }

  protected created(item: LoginSession): string {
    return $localize`:@@settings.sessions.created:Entrada: ${this.dateFormat.format(new Date(item.createdAt))}:date:`;
  }

  protected lastUsed(item: LoginSession): string {
    return $localize`:@@settings.sessions.last-used:Último uso: ${this.dateFormat.format(new Date(item.lastUsedAt))}:date:`;
  }

  protected ask(item: LoginSession): void {
    this.confirmingOthers.set(false);
    this.confirmingId.set(item.id);
    this.note.set(null);
  }

  protected async revoke(item: LoginSession): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (item.isCurrent && this.guestId() === null) {
        // A rota da sessão toma a mesma trava do refresh; Sair limpa o token em memória e navega.
        await this.auth.authorized((token) => this.api.revokeSession(token, item.id));
        await this.auth.logout();
        return;
      }
      await this.auth.authorized((token) => this.api.revokeSession(token, item.id, this.guestId()));
      this.confirmingId.set(null);
      await this.load(this.guestId());
      this.note.set($localize`:@@settings.sessions.revoked:Sessão encerrada.`);
    } catch {
      this.note.set(
        $localize`:@@settings.sessions.revoke-failed:Não foi possível encerrar a sessão agora.`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async revokeOthers(): Promise<void> {
    if (this.busy() || this.guestId() !== null) return;
    this.busy.set(true);
    try {
      await this.auth.authorized((token) => this.api.revokeOtherSessions(token));
      this.confirmingOthers.set(false);
      await this.load(null);
      this.note.set($localize`:@@settings.sessions.others-revoked:Outras sessões encerradas.`);
    } catch {
      this.note.set(
        $localize`:@@settings.sessions.revoke-failed:Não foi possível encerrar a sessão agora.`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async retry(): Promise<void> {
    await this.load(this.guestId());
  }

  private async load(guestId: string | null): Promise<void> {
    this.failed.set(false);
    try {
      this.sessions.set(await this.auth.authorized((token) => this.api.sessions(token, guestId)));
    } catch {
      this.sessions.set(null);
      this.failed.set(true);
    }
  }
}
