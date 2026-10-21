import { Component, computed, inject, input } from '@angular/core';
import { InstallHintService } from './install-hint.service';

/** Traços do desenho da linha (grade de 24): um celular com o sinal de mais. */
const PHONE_ADD_ICON = [
  'M7.5 3h9A1.5 1.5 0 0 1 18 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z',
  'M12 8.5v5',
  'M9.5 11h5',
] as const;

/**
 * Linha permanente "Adicionar à tela de início": abre a mesma folha da dica automática, mesmo depois de "Agora
 * não" ou "Não mostrar de novo". Existe só enquanto há o que oferecer (`mode() !== 'none'`): no app já instalado, e
 * no computador sem instalação pelo navegador, a linha some inteira (o `host` fica oculto, para não deixar um vão
 * no contêiner que a hospeda).
 *
 * Mora em Ajustes (seção Aparência) e na folha Personalizar da TV: é assim que o controle (apertado) continua sem
 * nenhum elemento fixo da dica.
 */
@Component({
  selector: 'app-install-hint-row',
  host: { '[hidden]': 'hidden()' },
  template: `
    <div class="ui-group">
      <button type="button" class="ui-row" (click)="hint.open()">
        @if (tile()) {
          <span class="ui-tile" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              @for (d of icon; track d) {
                <path [attr.d]="d" />
              }
            </svg>
          </span>
        }
        <span class="ui-row-text">
          <span class="ui-row-title" i18n="@@install.row.title">Adicionar à tela de início</span>
          <span class="ui-row-sub" i18n="@@install.row.sub"
            >Um atalho que abre como app e não ocupa espaço</span
          >
        </span>
      </button>
    </div>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }
    :host([hidden]) {
      display: none;
    }
  `,
})
export class InstallHintRow {
  protected readonly hint = inject(InstallHintService);
  protected readonly icon = PHONE_ADD_ICON;

  /** Com ladrilho de ícone à esquerda, como as outras linhas de Ajustes. */
  readonly tile = input(false);

  protected readonly hidden = computed(() => this.hint.mode() === 'none');
}
