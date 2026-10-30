import { Component, inject } from '@angular/core';
import { AppearanceService, ThemePreference } from '../../core/session/appearance.service';

interface ThemeChoice {
  readonly value: ThemePreference;
  readonly label: string;
}

/**
 * Seletor de tema em três opções lado a lado (Claro, Escuro, Automático), para trocar na hora sem abrir outra tela. Usa
 * a mesma preferência (e a mesma persistência) da tela de Aparência: o serviço guarda a escolha só neste aparelho.
 */
@Component({
  selector: 'app-theme-segment',
  template: `
    <fieldset class="segment">
      <legend class="ui-visually-hidden" i18n="@@settings.quick-theme.legend">Tema</legend>
      @for (choice of choices; track choice.value) {
        <label class="option">
          <input
            type="radio"
            name="settings-theme"
            [value]="choice.value"
            [checked]="preference() === choice.value"
            (change)="choose(choice.value)"
          />
          <span class="option-label">{{ choice.label }}</span>
        </label>
      }
    </fieldset>
  `,
  styles: `
    :host {
      display: block;
    }
    .segment {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 4px;
      min-width: 0;
      margin: 0;
      padding: 4px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
    }
    .option {
      position: relative;
      display: grid;
      place-items: center;
      min-height: var(--tap);
      padding: 0 var(--space-2);
      border-radius: var(--radius-sm);
      color: var(--a-ink2);
      font-weight: 650;
      cursor: pointer;
      transition:
        background-color var(--dur-fast) linear,
        color var(--dur-fast) linear;
    }
    .option-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* O botão de opção de verdade cobre a opção inteira, invisível: o toque cai nele. */
    .option input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      opacity: 0;
      cursor: pointer;
    }
    .option:has(input:checked) {
      background: var(--a-accent-soft);
      color: var(--a-accent-ink);
      box-shadow: inset 0 0 0 1.5px var(--a-accent);
    }
    .option:has(input:focus-visible) {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    @media (hover: hover) {
      .option:not(:has(input:checked)):hover {
        background: var(--a-surface-2);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .option {
        transition: none;
      }
    }
  `,
})
export class ThemeSegment {
  private readonly appearance = inject(AppearanceService);

  protected readonly preference = this.appearance.preference;

  protected readonly choices: readonly ThemeChoice[] = [
    { value: 'light', label: $localize`:@@settings.theme.light:Claro` },
    { value: 'dark', label: $localize`:@@settings.theme.dark:Escuro` },
    { value: 'auto', label: $localize`:@@settings.theme.auto:Automático` },
  ];

  protected choose(value: ThemePreference): void {
    this.appearance.set(value);
  }
}
