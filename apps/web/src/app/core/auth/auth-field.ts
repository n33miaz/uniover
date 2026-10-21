import {
  Component,
  ElementRef,
  computed,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AuthGlyph } from './auth-glyph';
import { MAX_EMAIL_LENGTH } from './auth-validation';
import { MAX_PASSWORD_LENGTH } from './password-strength';

/**
 * Campo das telas de entrada: rótulo sempre visível, entrada de 48 px, mensagem de erro ligada ao campo e, na
 * senha, o botão de mostrar/ocultar (44 px) e o aviso de Caps Lock. O conteúdo projetado fica logo abaixo do campo
 * (dicas, requisitos); quem projeta liga os próprios ids em `describedBy`.
 *
 * Sem validação própria: quem usa decide quando mostrar o erro (só depois de o campo perder o foco ou do envio) e o
 * passa em `error`. O valor é um `model`, então `[(value)]` basta.
 */
@Component({
  selector: 'app-auth-field',
  imports: [AuthGlyph],
  templateUrl: './auth-field.html',
  styleUrl: './auth-field.css',
})
export class AuthField {
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('control');

  readonly fieldId = input.required<string>();
  readonly name = input.required<string>();
  readonly label = input.required<string>();
  /** `text`: texto livre, como o nome da pessoa (sem as dicas de e-mail, com maiúscula nas palavras). */
  readonly kind = input<'email' | 'password' | 'text'>('email');
  /** Teto de digitação do campo; sem ele valem os de e-mail e de senha. */
  readonly maxChars = input<number | null>(null);
  readonly autocomplete = input.required<string>();
  readonly enterKeyHint = input<'next' | 'go' | 'done'>('next');
  /** Rótulo do botão de mostrar a senha (só no tipo `password`). */
  readonly toggleLabel = input<string>('');
  /** Texto do erro do campo; vazio quando está tudo certo. */
  readonly error = input<string | null>(null);
  /** Campo reprovado sem texto de erro próprio (a explicação está em outro lugar, como uma lista de requisitos). */
  readonly invalid = input(false);
  /** Ids de outros elementos que descrevem o campo (dicas, requisitos), além do erro. */
  readonly describedBy = input<string | null>(null);

  readonly value = model('');
  readonly blurred = output<void>();

  protected readonly shown = signal(false);
  protected readonly capsLock = signal(false);

  protected readonly isPassword = computed(() => this.kind() === 'password');
  protected readonly isEmail = computed(() => this.kind() === 'email');
  protected readonly inputType = computed(() => {
    if (this.isPassword()) return this.shown() ? 'text' : 'password';
    return this.isEmail() ? 'email' : 'text';
  });
  protected readonly maxLength = computed(
    () => this.maxChars() ?? (this.isPassword() ? MAX_PASSWORD_LENGTH : MAX_EMAIL_LENGTH),
  );
  protected readonly isInvalid = computed(() => this.invalid() || !!this.error());
  protected readonly errorId = computed(() => `${this.fieldId()}-error`);
  protected readonly description = computed(() => {
    const ids = [this.error() ? this.errorId() : null, this.describedBy()].filter(Boolean);
    return ids.length > 0 ? ids.join(' ') : null;
  });

  focus(select = false): void {
    const control = this.input().nativeElement;
    control.focus();
    if (select) control.select();
  }

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  protected toggle(): void {
    this.shown.update((visible) => !visible);
  }

  /**
   * Caps Lock ligado: lido do próprio evento de tecla (o navegador não expõe o estado de outro jeito). Só vale
   * enquanto o campo está em foco, e o aviso é um `status` (cortês), nunca um `alert`: é dica, não erro.
   */
  protected checkCapsLock(event: KeyboardEvent): void {
    this.capsLock.set(event.getModifierState?.('CapsLock') === true);
  }

  protected onBlur(): void {
    this.capsLock.set(false);
    this.blurred.emit();
  }
}
