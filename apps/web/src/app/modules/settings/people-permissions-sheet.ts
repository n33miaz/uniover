import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ApiProblem, isStepUpRequired, problemOf } from '../../core/auth/api-problem';
import type { GuestSummary } from '../../core/auth/auth-api';
import { leaveDialog } from '../../shared/ui/dialog-motion';
import { GuestPermissions, PeopleApi } from './people-api';
import { PeoplePermissionPicker } from './people-permission-picker';
import {
  hasModule,
  normalizePermissions,
  permissionSummary,
  samePermissions,
} from './people-permissions';
import { SettingsGlyph } from './settings-glyph';

/**
 * Folha que edita o que um convidado pode ver e fazer: sobe de baixo, sem botão de fechar (a saída é "Cancelar", Esc ou
 * "Salvar"). Mostra o seletor já marcado com o que a pessoa tem hoje e só deixa salvar se algo mudou e se sobrou ao
 * menos um módulo. Salvar manda a lista COMPLETA e pede a passkey (o interceptador abre o diálogo e repete o pedido).
 *
 * A folha desce antes de avisar a página, que atualiza a lista com o que a API devolveu e a tira do DOM. Se a API
 * disser que a pessoa já não está lá ou foi revogada, a folha explica, não deixa salvar e avisa a página para
 * atualizar a lista.
 */
@Component({
  selector: 'app-people-permissions-sheet',
  imports: [PeoplePermissionPicker, SettingsGlyph],
  templateUrl: './people-permissions-sheet.html',
  styleUrl: './people-permissions-sheet.css',
})
export class PeoplePermissionsSheet {
  private readonly api = inject(PeopleApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly guest = input.required<GuestSummary>();
  /** Salvou: o convidado como a API o devolveu. */
  readonly saved = output<GuestPermissions>();
  /** A pessoa não está mais lá ou já foi revogada: a lista da página está velha. */
  readonly outdated = output<void>();
  readonly closed = output<void>();

  /** O que a pessoa tem hoje, já na ordem do catálogo (a base para saber se algo mudou). */
  protected readonly initial = computed(() => normalizePermissions(this.guest().permissions));
  protected readonly draft = linkedSignal(() => this.initial());
  protected readonly busy = signal(false);
  /** A folha já está descendo: nada mais vale (nem salvar, nem cancelar de novo). */
  protected readonly leaving = signal(false);
  /** A pessoa saiu da lista (revogada ou apagada): não há mais o que salvar. */
  protected readonly gone = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly valid = computed(() => hasModule(this.draft()));
  protected readonly summary = computed(() => permissionSummary(this.draft()));
  protected readonly changed = computed(() => !samePermissions(this.draft(), this.initial()));
  protected readonly canSave = computed(
    () => this.changed() && this.valid() && !this.busy() && !this.leaving() && !this.gone(),
  );

  protected readonly title = computed(
    () => $localize`:@@settings.people.sheet.title:Permissões de ${this.guest().displayName}:name:`,
  );
  protected readonly hint = computed(
    () =>
      $localize`:@@settings.people.sheet.hint:O que ${this.guest().displayName}:name: poderá ver e fazer. Depois de salvar, a mudança pode levar até 30 segundos para valer.`,
  );

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      this.dialog().nativeElement.showModal();
    });
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (!this.busy()) this.leave(() => this.closed.emit());
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const updated = await this.api.setPermissions(this.guest().id, this.draft());
      this.leave(() => this.saved.emit(updated));
    } catch (error) {
      const problem = problemOf(error);
      if (problem && isGone(problem)) {
        this.gone.set(true);
        this.outdated.emit();
      }
      this.error.set(this.errorText(problem));
    } finally {
      this.busy.set(false);
    }
  }

  /** Toca a descida da folha e só então avisa a página. */
  private leave(then: () => void): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    leaveDialog(this.dialog().nativeElement, then);
  }

  /**
   * O texto de cada tipo de erro. O 403 de passkey vem primeiro: se a confirmação foi cancelada, o interceptador
   * devolve o 403 original, e é dele que a pessoa precisa saber ("nada mudou").
   */
  private errorText(problem: ApiProblem | null): string {
    if (problem && isStepUpRequired(problem)) {
      return $localize`:@@settings.people.sheet.error.unconfirmed:A mudança não foi confirmada com a passkey. Nada foi alterado.`;
    }
    switch (problem?.status) {
      case 0:
        return $localize`:@@settings.people.sheet.error.network:Sem conexão com o servidor. Nada foi alterado. Tente de novo.`;
      case 400:
        return $localize`:@@settings.people.sheet.error.invalid:Essa combinação de permissões não foi aceita. Confira as opções e tente de novo.`;
      case 403:
        return $localize`:@@settings.people.sheet.error.forbidden:Só um administrador pode mudar permissões. Nada foi alterado.`;
      case 404:
        return $localize`:@@settings.people.sheet.error.not-found:Essa pessoa não está mais na lista. Atualizamos a lista; nada foi alterado.`;
      case 409:
        return isGone(problem)
          ? $localize`:@@settings.people.sheet.error.revoked:O acesso dessa pessoa já foi revogado, então as permissões não podem mais mudar. Atualizamos a lista.`
          : $localize`:@@settings.people.sheet.error.conflict:Outra mudança aconteceu ao mesmo tempo. Nada foi alterado: confira e salve de novo.`;
      case 429: {
        const seconds = problem?.retryAfterSeconds;
        return seconds
          ? $localize`:@@settings.people.sheet.error.rate-limited-seconds:Muitas tentativas seguidas. Tente de novo em ${seconds}:seconds: s.`
          : $localize`:@@settings.people.sheet.error.rate-limited:Muitas tentativas seguidas. Espere um pouco e tente de novo.`;
      }
      default:
        return $localize`:@@settings.people.sheet.error.failed:Não foi possível salvar agora. Nada foi alterado. Tente de novo.`;
    }
  }
}

/** A pessoa não pode mais ser editada: sumiu da lista (404) ou já foi revogada (409 de acesso revogado). */
function isGone(problem: ApiProblem): boolean {
  return problem.status === 404 || (problem.status === 409 && problem.kind === 'guest-revoked');
}
