import { Component, ElementRef, afterNextRender, computed, inject, viewChild } from '@angular/core';
import { StepUpError, StepUpService } from './step-up.service';

/** Texto de cada ação perigosa conhecida; o que não está aqui recebe uma frase genérica. */
export function actionLabel(action: string | null): string {
  switch (action) {
    case 'devices.pair-approve':
      return $localize`:@@auth.step-up.action.pair-approve:aprovar o pareamento de um aparelho`;
    case 'identity.passkey-remove':
      return $localize`:@@auth.step-up.action.passkey-remove:remover uma passkey`;
    case 'identity.guest-invite':
      return $localize`:@@auth.step-up.action.guest-invite:criar um convite de convidado`;
    case 'identity.password-change':
      return $localize`:@@auth.step-up.action.password-change:trocar a senha`;
    case 'tv.bind-agent':
      return $localize`:@@auth.step-up.action.tv-bind-agent:trocar o computador que controla a TV`;
    case 'identity.permissions-change':
      return $localize`:@@auth.step-up.action.permissions-change:mudar as permissões de uma pessoa`;
    default:
      return $localize`:@@auth.step-up.action.generic:fazer uma ação protegida`;
  }
}

/**
 * Título do diálogo. Quase toda ação usa o mesmo ("Confirmar com passkey"); mudar permissões diz o que está sendo
 * confirmado, porque amplia o que uma pessoa pode fazer e merece o aviso já no título.
 */
export function actionTitle(action: string | null): string {
  switch (action) {
    case 'identity.permissions-change':
      return $localize`:@@auth.step-up.title.permissions-change:Confirmar a mudança de permissões`;
    default:
      return $localize`:@@auth.step-up.title:Confirmar com passkey`;
  }
}

function errorText(error: StepUpError): string {
  switch (error) {
    case 'cancelled':
      return $localize`:@@auth.step-up.error.cancelled:A confirmação foi cancelada ou demorou demais. Tente de novo.`;
    case 'refused':
      return $localize`:@@auth.step-up.error.refused:A passkey não foi aceita. Tente de novo.`;
    case 'network':
      return $localize`:@@auth.step-up.error.network:Sem conexão com o servidor. Verifique a rede e tente de novo.`;
    default:
      return $localize`:@@auth.step-up.error.failed:Não foi possível confirmar agora. Tente de novo.`;
  }
}

/**
 * Diálogo "Confirmar com passkey". Sem botão de fechar: a saída é "Cancelar" (ou Esc) e "Confirmar". O foco
 * inicial fica em "Cancelar", o caminho seguro para uma ação perigosa. Quem o abre e fecha é o `StepUpService`.
 */
@Component({
  selector: 'app-step-up-dialog',
  templateUrl: './step-up-dialog.html',
  styleUrl: './step-up-dialog.css',
})
export class StepUpDialog {
  protected readonly service = inject(StepUpService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly action = computed(() => actionLabel(this.service.action()));
  protected readonly title = computed(() => actionTitle(this.service.action()));
  protected readonly errorMessage = computed(() => {
    const error = this.service.error();
    return error ? errorText(error) : null;
  });

  constructor() {
    // showModal prende o foco no diálogo, deixa o resto da tela inerte e trata o Esc.
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected onCancel(event: Event): void {
    event.preventDefault(); // o serviço tira o diálogo do DOM; evita o fechamento duplo do navegador
    this.service.cancel();
  }
}
