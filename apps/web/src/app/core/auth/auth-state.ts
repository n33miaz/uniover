import { Component, ElementRef, input, viewChild } from '@angular/core';
import { AuthGlyph, AuthGlyphName } from './auth-glyph';

export type AuthStateTone = 'bad' | 'warn' | 'ok' | 'neutral';

/**
 * Estado de tela cheia dentro do cartão de entrada: ícone, título (o `h1` da tela), explicação e, se couber, o que
 * fazer em seguida; as ações (botões e links) são projetadas. Serve para o convite que não vale mais, o link
 * incompleto e o "tudo pronto".
 *
 * O texto leva o papel (`alert` ou `status`) e aceita foco: quando o estado aparece no lugar do formulário, o
 * botão que estava em foco some, e quem usa teclado ou leitor de tela precisa cair aqui, não no começo da página.
 */
@Component({
  selector: 'app-auth-state',
  imports: [AuthGlyph],
  templateUrl: './auth-state.html',
  styleUrl: './auth-state.css',
  host: { '[attr.data-tone]': 'tone()' },
})
export class AuthState {
  private readonly copy = viewChild.required<ElementRef<HTMLElement>>('copy');

  readonly tone = input<AuthStateTone>('neutral');
  readonly icon = input.required<AuthGlyphName>();
  readonly heading = input.required<string>();
  readonly detail = input.required<string>();
  /** O que fazer agora, em uma frase; aparece em destaque suave abaixo da explicação. */
  readonly advice = input<string | null>(null);
  readonly role = input<'alert' | 'status' | null>(null);

  focus(): void {
    this.copy().nativeElement.focus();
  }
}
