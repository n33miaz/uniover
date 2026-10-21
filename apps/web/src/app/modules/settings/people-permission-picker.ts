import { Component, computed, input, model, signal } from '@angular/core';
import {
  PermissionModel,
  TRAINING_MODULE,
  TV_ACTIONS,
  TV_MODULE,
  applyModel,
  hasModule,
  modelLabel,
  modelOf,
  permissionOptionLabel,
  permissionSummary,
  togglePermission,
} from './people-permissions';
import { SettingsGlyph } from './settings-glyph';

/** Cada seletor na tela tem os próprios nomes de grupo: o do convite e o da folha de edição podem estar abertos juntos. */
let nextPicker = 0;

/**
 * Seletor do que uma pessoa poderá ver e fazer: modelos prontos em cima e, embaixo, um interruptor por permissão,
 * agrupados em TV e Treino. Serve ao convite e à edição das permissões de quem já entrou.
 *
 * O toque no interruptor nunca é recusado: a escolha da pessoa vale primeiro e as dependências se acertam depois (ligar
 * uma ação da TV liga "Ver a TV"; desligar "Ver a TV" desliga as ações). Lista sem módulo nenhum não é impedida aqui:
 * o seletor avisa, e quem o hospeda não deixa criar nem salvar.
 */
@Component({
  selector: 'app-people-permission-picker',
  imports: [SettingsGlyph],
  templateUrl: './people-permission-picker.html',
  styleUrl: './people-permission-picker.css',
})
export class PeoplePermissionPicker {
  /** A lista escolhida, em duas vias: quem hospeda a lê e recebe de volta cada mudança, já normalizada. */
  readonly permissions = model.required<readonly string[]>();
  /** O resumo ao pé do seletor. A folha de edição o mostra no rodapé fixo (a lista é longa) e o desliga aqui. */
  readonly showSummary = input(true);

  protected readonly modelGroup = `people-picker-${nextPicker++}-model`;
  protected readonly models: readonly PermissionModel[] = ['tv-control', 'training', 'custom'];
  protected readonly tvModule = TV_MODULE;
  protected readonly trainingModule = TRAINING_MODULE;
  protected readonly tvOptions: readonly string[] = [TV_MODULE, ...TV_ACTIONS];

  /**
   * "Personalizado" escolhido de propósito enquanto a lista ainda bate com um modelo: sem isto o botão pareceria não
   * fazer nada. Qualquer interruptor mexido devolve a decisão à lista.
   */
  private readonly pickedCustom = signal(false);

  protected readonly mode = computed<PermissionModel>(() =>
    this.pickedCustom() ? 'custom' : modelOf(this.permissions()),
  );
  protected readonly valid = computed(() => hasModule(this.permissions()));
  protected readonly summary = computed(() => permissionSummary(this.permissions()));

  protected has(permission: string): boolean {
    return this.permissions().includes(permission);
  }

  protected optionText(permission: string): string {
    return permissionOptionLabel(permission);
  }

  protected modelText(model: PermissionModel): string {
    return modelLabel(model);
  }

  protected pickModel(model: PermissionModel): void {
    if (model === 'custom') {
      this.pickedCustom.set(true);
      return;
    }
    this.pickedCustom.set(false);
    this.permissions.set(applyModel(this.permissions(), model));
  }

  protected toggle(permission: string, event: Event): void {
    this.pickedCustom.set(false);
    this.permissions.set(
      togglePermission(this.permissions(), permission, (event.target as HTMLInputElement).checked),
    );
  }
}
