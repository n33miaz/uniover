import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  OnInit,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ApiProblem, isStepUpRequired, problemOf } from '../../core/auth/api-problem';
import { AuthApi, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import {
  closeDialog,
  leaveDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../shared/ui/dialog-motion';
import { cleanupKindText, cleanupOutcomeText } from '../../shared/tv-cleanup-text';
import { SettingsGlyph } from './settings-glyph';
import { SystemApi, TvCleanupReportItem, TvComputer, TvItem } from './system-api';

/** Tamanho máximo do nome da TV, o mesmo da API. */
const NAME_MAX = 60;

/** O que a folha estava fazendo quando deu erro: cada passo tem as suas recusas. */
type Step = 'create' | 'update' | 'members' | 'delete';

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/**
 * Folha que cria ou edita uma TV (só do administrador): o nome, o computador que a controla e quem a usa. Sobe de baixo,
 * sem botão de fechar (a saída é "Cancelar", Esc ou "Salvar"). Salvar faz só o que mudou, na ordem: criar ou mudar a TV e,
 * depois, a lista de pessoas; cada escrita pede a passkey (o interceptador abre o diálogo e repete o pedido). Se a TV foi
 * criada e a lista de pessoas falhou, a folha segue aberta já tratando a TV criada, e "Salvar" tenta só as pessoas.
 *
 * "Remover" fica no fim e pede uma confirmação em linha; a TV padrão não tem esse botão (a API também a recusa). Quem não
 * foi marcado em nenhuma TV continua vendo a padrão; numa TV que não é a padrão, só quem estiver marcado a vê.
 *
 * `closed` leva `true` quando algo mudou no servidor (a página relê a lista) e `false` quando nada mudou.
 */
@Component({
  selector: 'app-tv-edit-sheet',
  imports: [SettingsGlyph],
  templateUrl: './tv-edit-sheet.html',
  styleUrl: './tv-edit-sheet.css',
})
export class TvEditSheet implements OnInit {
  private readonly api = inject(SystemApi);
  private readonly auth = inject(AuthService);
  private readonly authApi = inject(AuthApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  /** A TV a editar; `null` cria uma nova. */
  readonly tv = input<TvItem | null>(null);
  /** Os computadores que a TV pode usar: os pareados que ainda não têm TV e o dela, se tiver. */
  readonly computers = input.required<readonly TvComputer[]>();
  readonly closed = output<boolean>();

  protected readonly maxName = NAME_MAX;
  /** A TV de que a folha trata agora: a editada ou, depois de criar, a criada (para tentar de novo só as pessoas). */
  protected readonly current = linkedSignal<TvItem | null>(() => this.tv());
  protected readonly name = linkedSignal(() => this.tv()?.name ?? '');
  protected readonly agent = linkedSignal<string | null>(() => {
    const own = this.tv()?.agentSlug;
    if (own) return own;
    const free = this.computers();
    return free.length === 1 ? free[0].slug : null;
  });

  /** Fechar apps em segundo plano na limpeza desta TV. Desligado por padrão. */
  protected readonly closeBackground = linkedSignal(
    () => this.tv()?.allowBackgroundAppClosing ?? false,
  );

  /** As últimas limpezas desta TV (`null` até chegarem); só quem edita uma TV que já existe as vê. */
  protected readonly reports = signal<readonly TvCleanupReportItem[] | null>(null);
  protected readonly reportsFailed = signal(false);

  protected readonly people = signal<readonly GuestSummary[] | null>(null);
  /** As contas marcadas e as que já estavam (`null` até a lista da TV chegar: sem ela não há o que comparar). */
  protected readonly members = signal<readonly string[]>([]);
  private readonly savedMembers = signal<readonly string[] | null>(null);
  protected readonly peopleFailed = signal(false);

  protected readonly busy = signal(false);
  protected readonly leaving = signal(false);
  protected readonly confirmingRemove = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Algo já mudou no servidor (a TV criada, por exemplo): ao sair, a página relê a lista. */
  private dirty = false;

  protected readonly creating = computed(() => this.current() === null);
  protected readonly title = computed(() =>
    this.creating()
      ? $localize`:@@settings.system.tv.sheet.title-new:Nova TV`
      : $localize`:@@settings.system.tv.sheet.title-edit:Editar TV`,
  );
  protected readonly canRemove = computed(() => {
    const tv = this.current();
    return tv !== null && !tv.isDefault;
  });
  protected readonly membersHint = computed(() =>
    this.current()?.isDefault
      ? $localize`:@@settings.system.tv.sheet.members-hint-default:Quem não está em nenhuma TV vê esta.`
      : $localize`:@@settings.system.tv.sheet.members-hint:Só quem estiver marcado vê esta TV.`,
  );

  private readonly nameChanged = computed(
    () => this.name().trim() !== (this.current()?.name ?? ''),
  );
  private readonly agentChanged = computed(
    () => this.agent() !== null && this.agent() !== this.current()?.agentSlug,
  );
  private readonly closeBackgroundChanged = computed(
    () =>
      !this.creating() &&
      this.closeBackground() !== (this.current()?.allowBackgroundAppClosing ?? false),
  );
  private readonly membersChanged = computed(() => {
    const base = this.savedMembers();
    return base !== null && !sameSet(this.members(), base);
  });
  protected readonly canSave = computed(() => {
    if (this.busy() || this.leaving() || this.confirmingRemove()) return false;
    const name = this.name().trim();
    if (name === '' || name.length > NAME_MAX) return false;
    if (this.creating()) return this.agent() !== null;
    return (
      this.nameChanged() ||
      this.agentChanged() ||
      this.closeBackgroundChanged() ||
      this.membersChanged()
    );
  });

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      // O fundo escurecido é o próprio <dialog>; só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.cancel());
    });
  }

  /** Só aqui os inputs já chegaram: a TV a editar decide de quem é a lista de pessoas a ler. */
  ngOnInit(): void {
    void this.loadPeople();
    void this.loadReports();
  }

  /** A linha de uma limpeza: o tipo e quando foi, e embaixo o que fez ou por que foi pulada. */
  protected reportTitle(report: TvCleanupReportItem): string {
    const when = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(report.startedAt));
    return report.trigger === 'automatic'
      ? $localize`:@@settings.system.tv.sheet.report-auto:${cleanupKindText(report.kind)}:kind: automática · ${when}:when:`
      : $localize`:@@settings.system.tv.sheet.report-manual:${cleanupKindText(report.kind)}:kind: manual · ${when}:when:`;
  }

  protected reportOutcome(report: TvCleanupReportItem): string {
    return cleanupOutcomeText(report);
  }

  protected platform(computer: TvComputer): string {
    switch (computer.platform) {
      case 'windows':
        return 'Windows';
      case 'macos':
        return 'macOS';
      case 'linux':
        return 'Linux';
      default:
        return computer.platform.charAt(0).toUpperCase() + computer.platform.slice(1);
    }
  }

  protected computerState(computer: TvComputer): string {
    return computer.online
      ? $localize`:@@settings.system.tv.state-online:Ligado`
      : $localize`:@@settings.system.tv.state-offline:Desligado`;
  }

  protected isMember(id: string): boolean {
    return this.members().includes(id);
  }

  protected toggleMember(id: string, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.members.update((list) =>
      on ? (list.includes(id) ? list : [...list, id]) : list.filter((item) => item !== id),
    );
  }

  protected toggleCloseBackground(event: Event): void {
    this.closeBackground.set((event.target as HTMLInputElement).checked);
  }

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (!this.busy()) this.leave(this.dirty);
  }

  protected askRemove(): void {
    this.error.set(null);
    this.confirmingRemove.set(true);
  }

  protected keep(): void {
    this.confirmingRemove.set(false);
  }

  protected async remove(): Promise<void> {
    const tv = this.current();
    if (!tv || this.busy() || tv.isDefault) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.deleteTv(tv.id);
      this.leave(true);
    } catch (error) {
      this.confirmingRemove.set(false);
      this.error.set(this.errorText(problemOf(error), 'delete'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set(null);
    let step: Step = this.creating() ? 'create' : 'update';
    try {
      let tv = this.current();
      if (!tv) {
        tv = await this.api.createTv(this.agent()!, this.name().trim());
        this.dirty = true;
        this.current.set(tv);
        // Uma TV nova não tem ninguém: o que estiver marcado agora ainda é só rascunho.
        this.savedMembers.set([]);
      } else if (this.nameChanged() || this.agentChanged() || this.closeBackgroundChanged()) {
        tv = await this.api.updateTv(tv.id, {
          ...(this.nameChanged() ? { name: this.name().trim() } : {}),
          ...(this.agentChanged() ? { agentSlug: this.agent()! } : {}),
          ...(this.closeBackgroundChanged()
            ? { allowBackgroundAppClosing: this.closeBackground() }
            : {}),
        });
        this.dirty = true;
        this.current.set(tv);
      }
      if (this.membersChanged()) {
        step = 'members';
        const saved = await this.api.setTvMembers(tv.id, this.members());
        this.dirty = true;
        this.savedMembers.set(saved);
      }
      this.leave(true);
    } catch (error) {
      this.error.set(this.errorText(problemOf(error), step));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadReports(): Promise<void> {
    const tv = this.current();
    if (!tv) return;
    try {
      this.reports.set(await this.api.tvCleanupReports(tv.id));
    } catch {
      this.reportsFailed.set(true);
    }
  }

  /** As pessoas que podem ser marcadas (contas ativas) e, ao editar, quem já usa a TV. */
  private async loadPeople(): Promise<void> {
    try {
      const tv = this.current();
      const [guests, members] = await Promise.all([
        this.auth.authorized((token) => this.authApi.guests(token)),
        tv ? this.api.tvMembers(tv.id) : Promise.resolve<string[]>([]),
      ]);
      this.people.set(guests.filter((guest) => guest.disabledAt === null));
      this.members.set(members);
      this.savedMembers.set(members);
    } catch {
      this.peopleFailed.set(true);
    }
  }

  /** Toca a descida da folha e só então avisa a página. */
  private leave(changed: boolean): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    const dialog = this.dialog().nativeElement;
    leaveDialog(dialog, () => {
      closeDialog(dialog);
      restoreDialogFocus(this.opener);
      this.closed.emit(changed);
    });
  }

  /**
   * O texto de cada recusa. O 403 de passkey vem primeiro: se a confirmação foi cancelada, o interceptador devolve o 403
   * original, e é dele que a pessoa precisa saber ("nada mudou").
   */
  private errorText(problem: ApiProblem | null, step: Step): string {
    if (problem && isStepUpRequired(problem)) {
      return $localize`:@@settings.system.tv.sheet.error.unconfirmed:A mudança não foi confirmada com a passkey. Nada foi alterado.`;
    }
    switch (problem?.status) {
      case 0:
        return $localize`:@@settings.system.tv.sheet.error.network:Sem conexão com o servidor. Tente de novo.`;
      case 404:
        return $localize`:@@settings.system.tv.sheet.error.not-found:Essa TV não existe mais. Feche e veja a lista.`;
      case 409:
        return step === 'delete'
          ? $localize`:@@settings.system.tv.sheet.error.default:A TV padrão não pode ser removida.`
          : $localize`:@@settings.system.tv.sheet.error.in-use:Esse computador já controla outra TV. Escolha outro.`;
      case 429:
        return $localize`:@@settings.system.tv.sheet.error.rate-limited:Muitas tentativas seguidas. Espere um pouco.`;
      default:
        break;
    }
    return step === 'members'
      ? $localize`:@@settings.system.tv.sheet.error.members-failed:A TV foi salva, mas as pessoas não. Salve de novo.`
      : $localize`:@@settings.system.tv.sheet.error.failed:Não foi possível salvar agora. Tente de novo.`;
  }
}
