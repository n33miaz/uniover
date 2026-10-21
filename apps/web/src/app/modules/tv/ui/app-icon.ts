import { Component, computed, input, signal } from '@angular/core';
import { AppIconSubject, fallbackGlyph, fallbackHue, iconSource } from './app-icon-source';

/**
 * Azulejo quadrado de cantos arredondados com o ícone de um app da TV. Todos têm o mesmo tamanho e o mesmo formato:
 * a imagem fica inteira e centralizada dentro do quadrado (sem cortar nem esticar), com a mesma folga em volta. O
 * que não é quadrado (o CineVS chega como banner 16:9) ganha faixas neutras em cima e embaixo, em vez de alargar o
 * azulejo. Sem ícone (ou se a imagem falhar), mostra a inicial do app sobre uma cor estável do pacote. É decorativo:
 * quem o usa dá o nome ao botão (`aria-label` ou o texto ao lado). O tamanho vem da variável `--tile`, definida por
 * quem o usa.
 */
@Component({
  selector: 'app-tv-app-icon',
  templateUrl: './app-icon.html',
  styleUrl: './app-icon.css',
})
export class AppIcon {
  readonly shortcut = input.required<AppIconSubject>();
  /** Em listas longas que rolam (o painel Apps), a imagem só carrega perto da tela; a fileira de cima é sempre imediata. */
  readonly lazy = input(false);

  /** O ícone cuja imagem falhou ao carregar: vale só para ele, então um ícone novo do mesmo app tenta de novo. */
  private readonly failed = signal<string | null>(null);

  private readonly declared = computed(() => iconSource(this.shortcut().iconDataUri));
  protected readonly source = computed(() => {
    const uri = this.declared();
    return uri && uri !== this.failed() ? uri : null;
  });

  protected readonly hue = computed(() => `hue-${fallbackHue(this.shortcut().package)}`);
  protected readonly glyph = computed(() => fallbackGlyph(this.shortcut()));

  protected markFailed(uri: string): void {
    this.failed.set(uri);
  }
}
