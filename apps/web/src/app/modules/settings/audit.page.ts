import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { problemOf } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { guestHome } from '../../core/auth/role.guard';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { ModuleRegistry } from '../../core/modules/module-registry';
import { SessionState } from '../../core/session/session-state';
import { AuditApi } from './audit-api';
import { AuditDownload } from './audit-download';
import { AuditFilterSheet } from './audit-filter-sheet';
import {
  actorLabel,
  auditActionLabel,
  describeChange,
  describeTarget,
  formatWhen,
  moduleLabel,
  outcomeView,
  periodLabel,
  retentionText,
  summarizeUserAgent,
} from './audit-labels';
import {
  AuditFilter,
  AuditItem,
  AuditPerson,
  AuditSources,
  EMPTY_FILTER,
  EMPTY_QUERY,
  activeFilterCount,
  itemKey,
  resolveQuery,
} from './audit-model';
import { SettingsGlyph } from './settings-glyph';

/** Em que pé está a lista: carregando a primeira página, pronta, com erro, ou sem rede. */
type Phase = 'loading' | 'ready' | 'error' | 'offline';

/** Qual parte do filtro um chip de filtro aplicado desliga. */
type FilterPart = 'person' | 'modules' | 'action' | 'outcome' | 'period';

interface AppliedChip {
  readonly part: FilterPart;
  readonly label: string;
  readonly aria: string;
}

/** Uma linha da lista, já em palavras. */
interface Row {
  readonly key: string;
  readonly item: AuditItem;
  readonly title: string;
  /** Quem agiu e quando, numa linha só (o nome atual da conta; nunca o e-mail). */
  readonly meta: string;
  readonly outcome: ReturnType<typeof outcomeView>;
}

/** Um par rótulo/valor da área de detalhes de uma linha. */
interface DetailLine {
  readonly label: string;
  readonly value: string;
}

/** Aviso curto sobre a exportação: o texto e o tom (erro vira alerta para o leitor de tela). */
interface ExportNote {
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'bad';
}

/** O nome do arquivo quando o servidor não sugere um: `auditoria-AAAAMMDD-HHMM.csv`, na hora do aparelho. */
function fallbackFilename(now: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  return `auditoria-${day}-${two(now.getHours())}${two(now.getMinutes())}.csv`;
}

/**
 * Auditoria (só do administrador): quem fez o quê, quando, de onde e com que resultado, das contas, dos aparelhos e da
 * TV numa lista só. Mostra uma página por vez ("Carregar mais" segue o cursor da API: a tela nunca carrega a trilha
 * inteira), com filtros por pessoa, módulo, ação, resultado e período, e exporta a mesma consulta em CSV.
 *
 * Só carrega quando se sabe que a conta é do administrador (a rota é dele): quem não é nunca gera estas chamadas. Se a
 * API recusar com 403 no meio do uso (o papel mudou), a tela confere o papel de novo e leva a pessoa para onde as outras
 * telas de administrador a levam. A auditoria não funciona offline, e a tela diz isso com calma.
 *
 * Nada daqui vai para log: IP, aparelho e o texto de um erro só aparecem na tela (e só para o administrador).
 */
@Component({
  selector: 'app-audit-page',
  imports: [AuditFilterSheet, SettingsGlyph],
  templateUrl: './audit.page.html',
  styleUrl: './audit.page.css',
})
export class AuditPage {
  private readonly api = inject(AuditApi);
  private readonly download = inject(AuditDownload);
  private readonly session = inject(SessionState);
  private readonly auth = inject(AuthService);
  private readonly authApi = inject(AuthApi);
  private readonly connectivity = inject(ConnectivityService);
  private readonly router = inject(Router);
  private readonly registry = inject(ModuleRegistry);
  private readonly injector = inject(Injector);

  private readonly filterButton = viewChild<ElementRef<HTMLButtonElement>>('filterButton');

  /**
   * Cada leitura da primeira página ganha um número; resposta de um número antigo (o filtro mudou no meio) é descartada,
   * senão uma página atrasada do filtro velho entraria na lista do novo.
   */
  private sequence = 0;
  private started = false;
  private sourcesLoading = false;
  private peopleLoading = false;

  protected readonly online = this.connectivity.online;
  protected readonly sources = signal<AuditSources | null>(null);
  protected readonly items = signal<readonly AuditItem[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly phase = signal<Phase>('loading');
  protected readonly loadingMore = signal(false);
  protected readonly moreFailed = signal(false);

  /** O que a pessoa escolheu; `query` é o mesmo filtro com o período já em instantes (fixo entre páginas e exportação). */
  protected readonly filter = signal<AuditFilter>(EMPTY_FILTER);
  private readonly query = signal(EMPTY_QUERY);

  protected readonly expanded = signal<string | null>(null);
  protected readonly sheetOpen = signal(false);
  protected readonly guests = signal<readonly AuditPerson[] | null>(null);
  protected readonly peopleFailed = signal(false);
  protected readonly exporting = signal(false);
  protected readonly exportNote = signal<ExportNote | null>(null);

  /** Sem rede nem a lista nem o carregamento adiantam: a tela diz isso em vez de girar para sempre. */
  protected readonly view = computed<Phase>(() =>
    this.phase() === 'loading' && !this.online() ? 'offline' : this.phase(),
  );
  protected readonly filterCount = computed(() => activeFilterCount(this.filter()));
  protected readonly selfId = computed(() => this.session.user()?.id ?? null);

  /** O administrador primeiro e depois os convidados: quem pode ser escolhido no filtro. */
  protected readonly people = computed<readonly AuditPerson[] | null>(() => {
    const guests = this.guests();
    if (guests === null) return null;
    const me = this.session.user();
    return me ? [{ id: me.id, name: me.displayName }, ...guests] : guests;
  });

  protected readonly retention = computed(() =>
    retentionText(this.sources(), this.filter().modules),
  );

  protected readonly appliedChips = computed<readonly AppliedChip[]>(() => {
    const filter = this.filter();
    const chips: AppliedChip[] = [];
    const add = (part: FilterPart, label: string) =>
      chips.push({
        part,
        label,
        aria: $localize`:@@settings.audit.chip-remove:Remover filtro: ${label}:label:`,
      });
    if (filter.person) {
      add('person', $localize`:@@settings.audit.chip.person:Pessoa: ${filter.person.name}:name:`);
    }
    if (filter.modules.length > 0) {
      const names = filter.modules.map(moduleLabel).join(', ');
      add('modules', $localize`:@@settings.audit.chip.module:Módulo: ${names}:names:`);
    }
    if (filter.action) {
      const action = auditActionLabel(filter.action);
      add('action', $localize`:@@settings.audit.chip.action:Ação: ${action}:action:`);
    }
    if (filter.outcome) {
      const outcome = outcomeView(filter.outcome).label;
      add('outcome', $localize`:@@settings.audit.chip.outcome:Resultado: ${outcome}:outcome:`);
    }
    if (filter.period !== 'any') add('period', periodLabel(filter.period));
    return chips;
  });

  protected readonly rows = computed<readonly Row[]>(() => {
    const now = new Date();
    return this.items().map((item) => ({
      key: itemKey(item),
      item,
      title: auditActionLabel(item.action),
      meta: `${actorLabel(item)} · ${formatWhen(item.occurredAt, now)}`,
      outcome: outcomeView(item.outcome),
    }));
  });

  /** Os detalhes da linha aberta (só ela os tem: o resto fica atrás de um toque). */
  protected readonly details = computed<readonly DetailLine[]>(() => {
    const open = this.expanded();
    const item = this.items().find((candidate) => itemKey(candidate) === open);
    return item ? this.detailsOf(item) : [];
  });

  constructor() {
    // Carrega quando há sessão confirmada (também quando uma sessão pendente é confirmada depois) e se sabe que a conta é
    // do administrador: a auditoria é rota de administrador, e quem não é nunca deve gerar estas chamadas.
    effect(() => {
      const admin = this.session.status() === 'authenticated' && this.session.role() === 'owner';
      if (admin && !this.started) {
        this.started = true;
        untracked(() => {
          void this.loadSources();
          void this.load();
        });
      }
    });

    // A rede voltou enquanto a lista esperava por ela: tenta de novo sozinha.
    effect(() => {
      if (this.online() && this.started && untracked(() => this.phase()) === 'offline') {
        untracked(() => void this.load());
      }
    });
  }

  protected rowId(row: Row): string {
    return `audit-details-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  protected toggle(key: string): void {
    this.expanded.update((open) => (open === key ? null : key));
  }

  /** A primeira página do filtro de agora: zera a lista e o cursor. */
  protected async load(): Promise<void> {
    const ticket = ++this.sequence;
    this.items.set([]);
    this.nextCursor.set(null);
    this.expanded.set(null);
    this.loadingMore.set(false);
    this.moreFailed.set(false);
    if (this.sources() === null) void this.loadSources();
    if (!this.online()) {
      this.phase.set('offline');
      return;
    }
    this.phase.set('loading');
    try {
      const page = await this.api.list(this.query());
      if (ticket !== this.sequence) return;
      this.items.set(uniqueItems([], page.items));
      this.nextCursor.set(page.nextCursor);
      this.phase.set('ready');
    } catch (error) {
      if (ticket !== this.sequence) return;
      if (await this.leaveIfNotAdmin(error)) return;
      this.phase.set(problemOf(error)?.isNetwork ? 'offline' : 'error');
    }
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    const ticket = this.sequence;
    this.loadingMore.set(true);
    this.moreFailed.set(false);
    try {
      const page = await this.api.list(this.query(), cursor);
      if (ticket !== this.sequence) return;
      this.items.update((current) => uniqueItems(current, page.items));
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (ticket !== this.sequence) return;
      if (await this.leaveIfNotAdmin(error)) return;
      this.moreFailed.set(true);
    } finally {
      if (ticket === this.sequence) this.loadingMore.set(false);
    }
  }

  /** As fontes dão as opções dos filtros e o prazo de guarda; se falharem, a lista segue sem elas. */
  protected async loadSources(): Promise<void> {
    if (this.sourcesLoading) return;
    this.sourcesLoading = true;
    try {
      this.sources.set(await this.api.sources());
    } catch {
      // Sem as fontes não há módulo nem ação para escolher e nenhum prazo a dizer; a lista não depende delas.
    } finally {
      this.sourcesLoading = false;
    }
  }

  /** Os convidados para o filtro por pessoa: só quando a folha abre, porque quase ninguém filtra por pessoa. */
  protected async loadPeople(): Promise<void> {
    if (this.peopleLoading) return;
    this.peopleLoading = true;
    this.peopleFailed.set(false);
    try {
      this.guests.set(await this.api.guests());
    } catch {
      this.peopleFailed.set(true);
    } finally {
      this.peopleLoading = false;
    }
  }

  protected openFilters(): void {
    this.sheetOpen.set(true);
    if (this.guests() === null) void this.loadPeople();
    if (this.sources() === null) void this.loadSources();
  }

  protected closeFilters(): void {
    this.sheetOpen.set(false);
    afterNextRender(() => this.filterButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected applyFilter(filter: AuditFilter): void {
    this.filter.set(filter);
    this.query.set(resolveQuery(filter, new Date()));
    this.exportNote.set(null);
    void this.load();
  }

  protected removeFilter(part: FilterPart): void {
    const filter = this.filter();
    switch (part) {
      case 'person':
        this.applyFilter({ ...filter, person: null });
        break;
      case 'modules':
        // Sem os módulos, a ação escolhida continua valendo (ela existe em alguma fonte).
        this.applyFilter({ ...filter, modules: [] });
        break;
      case 'action':
        this.applyFilter({ ...filter, action: null });
        break;
      case 'outcome':
        this.applyFilter({ ...filter, outcome: null });
        break;
      case 'period':
        this.applyFilter({ ...filter, period: 'any' });
        break;
    }
  }

  protected clearFilters(): void {
    this.applyFilter(EMPTY_FILTER);
  }

  /** O CSV da consulta de agora; o arquivo sai por download e o servidor registra a exportação na trilha. */
  protected async exportCsv(): Promise<void> {
    if (this.exporting() || !this.online()) return;
    this.exporting.set(true);
    this.exportNote.set(null);
    try {
      const file = await this.api.export(this.query());
      this.download.save(file.blob, file.filename ?? fallbackFilename(new Date()));
      this.exportNote.set(
        file.truncated
          ? {
              tone: 'warn',
              text: $localize`:@@settings.audit.export.truncated:O arquivo traz só os registros mais recentes: o limite da exportação foi atingido. Filtre por período ou por pessoa para pegar o resto.`,
            }
          : {
              tone: 'ok',
              text: $localize`:@@settings.audit.export.done:Arquivo baixado. Esta exportação ficou registrada na auditoria.`,
            },
      );
    } catch (error) {
      if (await this.leaveIfNotAdmin(error)) return;
      this.exportNote.set({ tone: 'bad', text: this.exportError(error) });
    } finally {
      this.exporting.set(false);
    }
  }

  private detailsOf(item: AuditItem): readonly DetailLine[] {
    const unknown = $localize`:@@settings.audit.detail.unknown:Não registrado`;
    const lines: DetailLine[] = [];
    const target = describeTarget(item);
    if (target) {
      lines.push({ label: $localize`:@@settings.audit.detail.target:Alvo`, value: target });
    }
    const change = describeChange(item);
    if (change) {
      lines.push({ label: $localize`:@@settings.audit.detail.change:O que mudou`, value: change });
    }
    lines.push(
      { label: $localize`:@@settings.audit.detail.module:Módulo`, value: moduleLabel(item.module) },
      { label: $localize`:@@settings.audit.detail.ip:IP`, value: item.ip ?? unknown },
      {
        label: $localize`:@@settings.audit.detail.device:Aparelho`,
        value: summarizeUserAgent(item.userAgent) ?? unknown,
      },
    );
    return lines;
  }

  private exportError(error: unknown): string {
    const problem = problemOf(error);
    if (problem?.isNetwork) {
      return $localize`:@@settings.audit.export.network:Sem conexão com o servidor. O arquivo não foi baixado; tente de novo quando a rede voltar.`;
    }
    if (problem?.status === 400) {
      return $localize`:@@settings.audit.export.invalid:Esses filtros não foram aceitos para a exportação. Mude os filtros e tente de novo.`;
    }
    if (problem?.status === 429) {
      return $localize`:@@settings.audit.export.rate-limited:Muitas tentativas seguidas. Espere um pouco e tente de novo.`;
    }
    return $localize`:@@settings.audit.export.failed:Não foi possível exportar agora. Tente de novo.`;
  }

  /**
   * 403 numa rota de administrador: o papel mudou no servidor. Confere o papel de novo e, se a conta já não é de
   * administrador, leva para onde as outras telas de administrador levam (o primeiro módulo que a pessoa pode usar). Se a
   * conferência falhar, ou ainda disser administrador, não há para onde levar: devolve falso e a tela mostra o erro comum.
   */
  private async leaveIfNotAdmin(error: unknown): Promise<boolean> {
    if (problemOf(error)?.status !== 403) return false;
    try {
      this.session.setUser(
        await this.auth.authorized((token) => this.authApi.me(token), { stepUp: false }),
      );
    } catch {
      return false;
    }
    if (this.session.role() === 'owner') return false;
    await this.router.navigateByUrl(guestHome(this.session, this.registry), { replaceUrl: true });
    return true;
  }
}

/** Junta a página nova à lista sem repetir uma linha (empates de instante entre fontes podem reaparecer na página seguinte). */
function uniqueItems(
  current: readonly AuditItem[],
  next: readonly AuditItem[],
): readonly AuditItem[] {
  const seen = new Set(current.map(itemKey));
  return [...current, ...next.filter((item) => !seen.has(itemKey(item)))];
}
