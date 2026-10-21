import { Component, ElementRef, inject, input } from '@angular/core';
import { AuthGlyph, AuthGlyphName } from './auth-glyph';

export type AuthTone = 'bad' | 'warn' | 'ok';

/** Espera em andamento, já formatada: o número que anda (só para os olhos), a frase para o leitor de tela e o total. */
export interface AuthCountdown {
  readonly label: string;
  readonly words: string;
  readonly total: number;
}

/** Aviso já resolvido (texto, ícone, tom e papel); `waiting` pede a contagem da espera embaixo. */
export interface AuthBanner {
  readonly tone: AuthTone;
  readonly role: 'alert' | 'status';
  readonly icon: AuthGlyphName;
  readonly heading: string;
  readonly detail: string | null;
  readonly waiting: boolean;
}

/**
 * Faixa de aviso das telas de entrada: ícone, título curto, uma explicação se couber e, numa espera (bloqueio ou
 * limite de tentativas), a contagem regressiva. O próprio elemento leva o papel (`alert` para erro, `status` para
 * "pronto") e aceita foco, para quem usa teclado ou leitor de tela cair nele depois de um envio recusado.
 *
 * A contagem anda sem ser lida (`aria-hidden`): o leitor de tela ouve a espera uma vez, em palavras, dentro do
 * próprio aviso. Quando a espera acaba, quem usa isto troca a faixa por uma de "pronto".
 */
@Component({
  selector: 'app-auth-notice',
  imports: [AuthGlyph],
  templateUrl: './auth-notice.html',
  styleUrl: './auth-notice.css',
  host: {
    class: 'ui-rise',
    tabindex: '-1',
    '[attr.role]': 'role()',
    '[attr.data-tone]': 'tone()',
  },
})
export class AuthNotice {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly tone = input<AuthTone>('bad');
  readonly role = input<'alert' | 'status'>('alert');
  readonly icon = input<AuthGlyphName>('alert-circle');
  readonly heading = input.required<string>();
  readonly detail = input<string | null>(null);
  readonly countdown = input<AuthCountdown | null>(null);

  focus(): void {
    this.host.nativeElement.focus();
  }
}
