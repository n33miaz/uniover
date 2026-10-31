import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { closeDialog, leaveDialog, onDialogBackdropClick } from '../../shared/ui/dialog-motion';
import {
  auditActionLabel,
  knownActionLabel,
  moduleLabel,
  outcomeChoices,
  outcomeView,
  periodLabel,
} from './audit-labels';
import {
  AUDIT_PERIODS,
  AuditFilter,
  AuditOutcome,
  AuditPerson,
  AuditPeriod,
  AuditSource,
  AuditSources,
  EMPTY_FILTER,
  activeFilterCount,
  sameFilter,
} from './audit-model';
import { SettingsGlyph } from './settings-glyph';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';

/** As ações de uma fonte, já com nome: o que a lista de ações da folha mostra num grupo. */
interface ActionGroup {
  readonly module: string;
  readonly label: string;
  readonly actions: readonly { readonly code: string; readonly label: string }[];
}

/**
 * Folha de filtros da Auditoria: sobe de baixo, sem botão de fechar (a saída é "Cancelar", Esc ou "Aplicar"). Edita um
 * rascunho; o que a página mostra só muda quando a pessoa aplica. Pessoa, módulo, ação, resultado e período se combinam
 * (todos valem juntos). As opções de módulo e ação vêm das fontes da API; ação que a tela não sabe nomear não é oferecida
 * (nunca aparece um código).
 *
 * Todas as escolhas são chips de rádio ou de caixa, nunca `<select>`: o app não permite estilo em linha (CSP) e o WebKit
 * grava um no `<select>`, o que o navegador denuncia como violação. As ações só aparecem para o módulo escolhido: são
 * mais de trinta, e uma lista só delas pesaria a folha.
 */
@Component({
  selector: 'app-audit-filter-sheet',
  imports: [SettingsGlyph, LoadingSkeleton],
  templateUrl: './audit-filter-sheet.html',
  styleUrl: './audit-filter-sheet.css',
})
export class AuditFilterSheet {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** O filtro que está valendo na lista (o rascunho começa nele). */
  readonly filter = input.required<AuditFilter>();
  /** As fontes da trilha; `null` enquanto não chegaram (ou se falharam): sem elas só há resultado e período. */
  readonly sources = input<AuditSources | null>(null);
  /** As pessoas que dá para escolher; `null` enquanto carregam. */
  readonly people = input<readonly AuditPerson[] | null>(null);
  readonly peopleFailed = input(false);
  /** A conta de quem olha: aparece como "(você)" na lista. */
  readonly selfId = input<string | null>(null);

  readonly applied = output<AuditFilter>();
  readonly closed = output<void>();
  readonly retryPeople = output<void>();

  protected readonly draft = linkedSignal(() => this.filter());
  /** A folha já está descendo: nada mais vale. */
  protected readonly leaving = signal(false);

  protected readonly periods = AUDIT_PERIODS;
  protected readonly outcomes = computed(() => outcomeChoices(this.sources()));
  protected readonly moduleChoices = computed(() =>
    (this.sources()?.sources ?? []).map((source) => ({
      code: source.module,
      label: moduleLabel(source.module),
    })),
  );

  /**
   * As ações dos módulos escolhidos, agrupadas por fonte. Sem módulo escolhido não há lista (a folha pede um módulo),
   * exceto quando já há uma ação no filtro: então vale a fonte dessa ação, para ela continuar visível e trocável.
   */
  protected readonly actionGroups = computed<readonly ActionGroup[]>(() => {
    const { modules, action } = this.draft();
    const inView = (source: AuditSource) =>
      modules.length > 0
        ? modules.includes(source.module)
        : !!action && source.actions.includes(action);
    return (this.sources()?.sources ?? [])
      .filter(inView)
      .map((source) => ({
        module: source.module,
        label: moduleLabel(source.module),
        actions: source.actions
          .filter((code) => knownActionLabel(code) !== null)
          .map((code) => ({ code, label: auditActionLabel(code) })),
      }))
      .filter((group) => group.actions.length > 0);
  });

  /** A lista de pessoas com a que já está no filtro (mesmo que a lista não tenha chegado ou a pessoa já não esteja nela). */
  protected readonly personChoices = computed<readonly AuditPerson[]>(() => {
    const list = this.people() ?? [];
    const chosen = this.draft().person;
    return chosen && !list.some((person) => person.id === chosen.id) ? [chosen, ...list] : list;
  });

  protected readonly changed = computed(() => !sameFilter(this.draft(), this.filter()));
  protected readonly hasFilters = computed(() => activeFilterCount(this.draft()) > 0);

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      dialog.showModal();
      // O fundo escurecido é o próprio <dialog>; só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.cancel());
    });
  }

  protected personLabel(person: AuditPerson): string {
    return person.id === this.selfId()
      ? $localize`:@@settings.audit.filter.person-self:${person.name}:name: (você)`
      : person.name;
  }

  protected outcomeLabel(outcome: AuditOutcome): string {
    return outcomeView(outcome).label;
  }

  protected periodText(period: AuditPeriod): string {
    return periodLabel(period);
  }

  protected setPerson(id: string | null): void {
    const person = this.personChoices().find((candidate) => candidate.id === id) ?? null;
    this.draft.update((draft) => ({ ...draft, person }));
  }

  protected hasModule(code: string): boolean {
    return this.draft().modules.includes(code);
  }

  /** Liga ou desliga um módulo; a ação escolhida sai se já não pertence a nenhum dos módulos em vista. */
  protected toggleModule(code: string): void {
    this.draft.update((draft) => {
      const modules = draft.modules.includes(code)
        ? draft.modules.filter((module) => module !== code)
        : [...draft.modules, code];
      const sources = this.sources()?.sources ?? [];
      const stillThere =
        draft.action === null ||
        sources
          .filter((source) => modules.length === 0 || modules.includes(source.module))
          .some((source) => source.actions.includes(draft.action!));
      return { ...draft, modules, action: stillThere ? draft.action : null };
    });
  }

  protected setAction(code: string | null): void {
    this.draft.update((draft) => ({ ...draft, action: code }));
  }

  protected setOutcome(outcome: AuditOutcome | null): void {
    this.draft.update((draft) => ({ ...draft, outcome }));
  }

  protected setPeriod(period: AuditPeriod): void {
    this.draft.update((draft) => ({ ...draft, period }));
  }

  protected clear(): void {
    this.draft.set(EMPTY_FILTER);
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    this.leave(() => this.closed.emit());
  }

  protected apply(event: Event): void {
    event.preventDefault();
    const filter = this.draft();
    this.leave(() => this.applied.emit(filter));
  }

  /** Toca a descida da folha e só então avisa a página. */
  private leave(then: () => void): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    const dialog = this.dialog().nativeElement;
    leaveDialog(dialog, () => {
      closeDialog(dialog);
      then();
    });
  }
}
