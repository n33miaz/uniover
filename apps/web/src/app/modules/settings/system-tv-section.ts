import {
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph } from './settings-glyph';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import { SystemApi, TvComputer, TvItem } from './system-api';
import { TvEditSheet } from './tv-edit-sheet';

/** O estado de uma TV em palavras da pessoa, e o tom do chip que o mostra. */
interface RowState {
  readonly label: string;
  readonly tone: 'accent' | 'warn' | 'plain';
}

/** A folha aberta: a TV que ela edita (`null` cria uma nova) e o botão que a abriu (o foco volta a ele). */
interface OpenSheet {
  readonly tv: TvItem | null;
  readonly opener: HTMLElement | null;
}

/**
 * Sistema > TVs: as TVs do app. O administrador vê cada uma com o computador que a controla e se ele está ligado,
 * adiciona uma TV (um computador pareado que ainda não tem TV mais um nome) e, tocando numa TV, renomeia, troca o
 * computador, escolhe quem a usa e a remove (a padrão não). Tudo isso mora na folha de edição; a tela só lista e abre.
 *
 * Só carrega quando se sabe que a conta é do administrador (a rota é dele): quem não é nunca gera essa chamada. Escrita
 * nunca passa pela fila offline: sem rede, a folha explica ao tentar salvar.
 */
@Component({
  selector: 'app-system-tv-section',
  imports: [RouterLink, SettingsGlyph, LoadingSkeleton, TvEditSheet],
  templateUrl: './system-tv-section.html',
  styleUrl: './system-tv-section.css',
})
export class SystemTvSection {
  private readonly api = inject(SystemApi);
  private readonly session = inject(SessionState);
  private readonly injector = inject(Injector);

  protected readonly tvs = signal<readonly TvItem[] | null>(null);
  protected readonly computers = signal<readonly TvComputer[]>([]);
  protected readonly loadFailed = signal(false);
  protected readonly sheet = signal<OpenSheet | null>(null);
  protected readonly saved = signal(false);

  /** Os computadores pareados que ainda não têm TV: só eles podem ganhar uma nova. */
  protected readonly freeComputers = computed(() => {
    const used = new Set((this.tvs() ?? []).map((tv) => tv.agentSlug));
    return this.computers().filter((computer) => !used.has(computer.slug));
  });

  constructor() {
    // Carrega quando há sessão confirmada (também quando uma sessão pendente é confirmada depois) e se sabe que a conta é
    // do administrador: as TVs e os computadores são rota de administrador, e quem não é nunca deve gerar essa chamada.
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.tvs()) === null
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      const [tvs, config] = await Promise.all([this.api.tvs(), this.api.tvConfig()]);
      this.tvs.set(tvs);
      this.computers.set(config.agents);
    } catch {
      this.loadFailed.set(true);
    }
  }

  /** O computador de uma TV, para a linha da lista: o nome dele e, se a API disser, o tipo da TV. */
  protected computerText(tv: TvItem): string {
    const computer = tv.agentSlug
      ? this.computers().find((item) => item.slug === tv.agentSlug)
      : undefined;
    const name =
      computer?.name ??
      (tv.agentSlug
        ? $localize`:@@settings.system.tv.not-found:Computador não encontrado`
        : $localize`:@@settings.system.tv.none:Nenhum computador escolhido`);
    if (tv.kind === 'samsung') return `${name} · Samsung`;
    return tv.kind === 'android' ? `${name} · Android` : name;
  }

  protected stateOf(tv: TvItem): RowState {
    if (tv.agentSlug && !this.computers().some((item) => item.slug === tv.agentSlug)) {
      return { label: $localize`:@@settings.system.tv.state-unknown:Não encontrado`, tone: 'warn' };
    }
    return tv.online
      ? { label: $localize`:@@settings.system.tv.state-online:Ligado`, tone: 'accent' }
      : { label: $localize`:@@settings.system.tv.state-offline:Desligado`, tone: 'plain' };
  }

  /** Os computadores que a folha oferece: os livres e, ao editar, o da própria TV (que deixa de estar livre). */
  protected computersFor(tv: TvItem | null): readonly TvComputer[] {
    const own = tv?.agentSlug ? this.computers().find((item) => item.slug === tv.agentSlug) : null;
    return own ? [own, ...this.freeComputers()] : this.freeComputers();
  }

  protected openSheet(tv: TvItem | null, opener: HTMLElement): void {
    this.saved.set(false);
    this.sheet.set({ tv, opener });
  }

  /** A folha saiu: se algo mudou a lista é lida de novo; o foco volta ao botão que a abriu. */
  protected async sheetClosed(changed: boolean): Promise<void> {
    const opener = this.sheet()?.opener ?? null;
    this.sheet.set(null);
    // Com a folha ainda no DOM a tela está inerte e o foco não entra: devolve-o depois que ela sair.
    afterNextRender(() => opener?.focus({ preventScroll: true }), { injector: this.injector });
    if (!changed) return;
    await this.load();
    this.saved.set(!this.loadFailed());
  }
}
