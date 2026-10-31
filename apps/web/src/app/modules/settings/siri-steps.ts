import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { SettingsGlyph } from './settings-glyph';
import {
  SIRI_HEADER,
  SIRI_TOKEN_PLACEHOLDER,
  SiriAction,
  SiriField,
  actionOfCode,
  endpointUrl,
  fieldsOf,
  instructionsText,
} from './siri-model';

/** Um cartão por ação, já com o que colar no app Atalhos. */
interface StepCard {
  readonly action: SiriAction;
  readonly fields: readonly SiriField[];
}

/**
 * O passo a passo de cada atalho: o que preencher na ação "Obter Conteúdo de URL" do app Atalhos (de fábrica no iPhone),
 * com um botão de copiar por valor e um para o texto inteiro. Com a chave à mão (recém-criada) ela já vem nos valores;
 * depois o lugar dela fica marcado, porque a API só guarda o hash e não consegue mostrá-la de novo.
 */
@Component({
  selector: 'app-siri-steps',
  imports: [SettingsGlyph],
  templateUrl: './siri-steps.html',
  styleUrl: './siri-steps.css',
})
export class SiriSteps {
  readonly tvId = input.required<string>();
  /** Os códigos das ações da chave. */
  readonly actions = input.required<readonly string[]>();
  /** Nome mostrado de cada app da TV, por id (`app:{id}`). */
  readonly appNames = input<ReadonlyMap<string, string>>(new Map());
  /** A chave em texto claro, só enquanto a tela a tem; `null` depois. */
  readonly token = input<string | null>(null);

  private readonly doc = inject(DOCUMENT);

  protected readonly header = SIRI_HEADER;
  protected readonly method = 'POST';
  protected readonly note = signal<{ text: string; error: boolean } | null>(null);

  protected readonly url = computed(() => endpointUrl(this.doc.defaultView?.location.origin ?? ''));

  protected readonly cards = computed<readonly StepCard[]>(() =>
    this.actions()
      .map((code) => actionOfCode(code, this.appNames()))
      .filter((action): action is SiriAction => action !== null)
      .map((action) => ({ action, fields: fieldsOf(action.code, this.tvId()) })),
  );

  protected tokenText(): string {
    return this.token() ?? SIRI_TOKEN_PLACEHOLDER;
  }

  protected async copy(text: string): Promise<void> {
    await this.write(text, $localize`:@@settings.siri.copied:Copiado.`);
  }

  protected async copyAll(card: StepCard): Promise<void> {
    const origin = this.doc.defaultView?.location.origin ?? '';
    await this.write(
      instructionsText(card.action, origin, this.tvId(), this.token()),
      $localize`:@@settings.siri.copied-all:Passo a passo copiado.`,
    );
  }

  protected copyLabel(what: string): string {
    return $localize`:@@settings.siri.copy-label:Copiar ${what}:what:`;
  }

  private async write(text: string, done: string): Promise<void> {
    const clipboard = this.doc.defaultView?.navigator?.clipboard;
    try {
      if (!clipboard) throw new Error('sem área de transferência');
      await clipboard.writeText(text);
      this.note.set({ text: done, error: false });
    } catch {
      this.note.set({
        text: $localize`:@@settings.siri.copy-failed:Não deu para copiar sozinho: toque no texto, selecione e copie.`,
        error: true,
      });
    }
  }
}
