import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthApi, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import { SettingsGlyph } from './settings-glyph';
import { SystemApi, TvComputer, TvItem } from './system-api';

/** Uma TV na linha de uma pessoa: o apelido que todos leem, o computador (nome técnico, só aqui) e o que a pessoa faz nela. */
interface PersonTv {
  readonly id: string;
  readonly name: string;
  readonly technical: string;
  readonly online: boolean;
  /** `true` controla a TV; `false` só a vê. */
  readonly controls: boolean;
}

/** Uma pessoa da lista: o nome, o estado da conta e as TVs que ela vê. `tvs` nulo é "sem acesso à TV". */
interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly state: 'admin' | 'paused' | 'active';
  readonly tvs: readonly PersonTv[] | null;
}

/**
 * TVs por Pessoa (só do administrador): quem vê e quem controla cada TV, e de qual computador ela vem. É a visão
 * compartilhada que fica só aqui: quem usa a TV vê o apelido dela e mais nada. O que cada pessoa vê vem do servidor (a
 * mesma regra da tela da TV); a tela só junta isso com os nomes, as permissões e os computadores.
 *
 * Só carrega para o administrador (a rota é dele): quem não é nunca gera essa chamada.
 */
@Component({
  selector: 'app-tv-people-page',
  imports: [LoadingSkeleton, SettingsGlyph],
  templateUrl: './tv-people.page.html',
  styleUrl: './tv-people.page.css',
})
export class TvPeoplePage {
  private readonly api = inject(SystemApi);
  private readonly auth = inject(AuthService);
  private readonly authApi = inject(AuthApi);
  private readonly session = inject(SessionState);

  protected readonly rows = signal<readonly PersonRow[] | null>(null);
  protected readonly failed = signal(false);
  protected readonly tvCount = signal(0);

  /** Sem nenhuma TV não há o que mostrar por pessoa. */
  protected readonly empty = computed(() => this.rows() !== null && this.tvCount() === 0);

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
    this.failed.set(false);
    try {
      const [tvs, config, guests] = await Promise.all([
        this.api.tvs(),
        this.api.tvConfig(),
        this.auth.authorized((token) => this.authApi.guests(token)),
      ]);
      const active = guests.filter((guest) => guest.disabledAt === null);
      const access = await this.api.tvAccess(active.map((guest) => guest.id));
      const visible = new Map(access.map((person) => [person.userId, person.tvIds]));
      this.tvCount.set(tvs.length);
      this.rows.set([
        this.ownerRow(tvs, config.agents),
        ...active.map((guest) =>
          this.guestRow(guest, tvs, config.agents, visible.get(guest.id) ?? []),
        ),
      ]);
    } catch {
      this.failed.set(true);
    }
  }

  /** O administrador vê e controla todas as TVs. */
  private ownerRow(tvs: readonly TvItem[], computers: readonly TvComputer[]): PersonRow {
    return {
      id: 'owner',
      name: this.session.user()?.displayName || $localize`:@@settings.tv-people.you:Você`,
      state: 'admin',
      tvs: tvs.map((tv) => this.personTv(tv, computers, true)),
    };
  }

  private guestRow(
    guest: GuestSummary,
    tvs: readonly TvItem[],
    computers: readonly TvComputer[],
    visibleIds: readonly string[],
  ): PersonRow {
    const hasTv = guest.permissions.includes('module:tv');
    const controls = guest.permissions.includes('tv:control');
    return {
      id: guest.id,
      name: guest.displayName,
      state: guest.pausedAt === null ? 'active' : 'paused',
      tvs: hasTv
        ? tvs
            .filter((tv) => visibleIds.includes(tv.id))
            .map((tv) => this.personTv(tv, computers, controls))
        : null,
    };
  }

  private personTv(tv: TvItem, computers: readonly TvComputer[], controls: boolean): PersonTv {
    const computer = tv.agentSlug
      ? computers.find((item) => item.slug === tv.agentSlug)
      : undefined;
    const name = computer?.name ?? $localize`:@@settings.tv-people.no-computer:Sem computador`;
    const kind = tv.kind === 'samsung' ? 'Samsung' : tv.kind === 'android' ? 'Android' : null;
    return {
      id: tv.id,
      name: tv.name,
      technical: kind ? `${name} · ${kind}` : name,
      online: tv.online,
      controls,
    };
  }

  protected stateLabel(row: PersonRow): string | null {
    switch (row.state) {
      case 'admin':
        return $localize`:@@settings.tv-people.state-admin:Administrador`;
      case 'paused':
        return $localize`:@@settings.tv-people.state-paused:Pausado`;
      default:
        return null;
    }
  }

  protected accessLabel(tv: PersonTv): string {
    return tv.controls
      ? $localize`:@@settings.tv-people.controls:Controla`
      : $localize`:@@settings.tv-people.views:Só Vê`;
  }
}
