import { Component, InjectionToken, computed, inject, input, signal } from '@angular/core';
import { AppIconSubject, fallbackGlyph, fallbackHue, iconSource } from './app-icon-source';
import {
  IconPixelReader,
  cachedIconFit,
  fitFromImage,
  readIconPixels,
  rememberIconFit,
} from './app-icon-fit';

/** Como o azulejo lê os pixels de um ícone carregado; os testes põem um leitor de mentira (o jsdom não tem canvas). */
export const ICON_PIXEL_READER = new InjectionToken<IconPixelReader>('ICON_PIXEL_READER', {
  providedIn: 'root',
  factory: () => readIconPixels,
});

/**
 * Azulejo quadrado de cantos arredondados com o ícone de um app da TV. Todos têm o mesmo tamanho e o mesmo formato, e o
 * ícone enche o azulejo de ponta a ponta (`cover`, sem folga). A margem que o próprio ícone traz (uma faixa transparente
 * ou uma moldura de uma cor só) é medida uma vez, quando a imagem carrega, e aparada só com CSS (um `transform` sobre a
 * imagem); a cor das bordas vira o fundo do azulejo. Se a medida não é possível (sem canvas, imagem estranha), o
 * ícone aparece em `cover` simples, sem erro. O que não é quadrado (um banner 16:9 antigo) é centralizado e cortado
 * pelos lados, nunca ganha faixas. Sem ícone (ou se a imagem falhar), mostra a inicial do app sobre uma cor estável do
 * pacote. É decorativo: quem o usa dá o nome ao botão (`aria-label` ou o texto ao lado). O tamanho vem da variável
 * `--tile`, definida por quem o usa.
 */
@Component({
  selector: 'app-tv-app-icon',
  templateUrl: './app-icon.html',
  styleUrl: './app-icon.css',
  host: { '[style.background-color]': 'fit()?.background ?? null' },
})
export class AppIcon {
  readonly shortcut = input.required<AppIconSubject>();
  /** Em listas longas que rolam (o painel Apps), a imagem só carrega perto da tela; a fileira de cima é sempre imediata. */
  readonly lazy = input(false);

  private readonly readPixels = inject(ICON_PIXEL_READER);

  /** O ícone cuja imagem falhou ao carregar: vale só para ele, então um ícone novo do mesmo app tenta de novo. */
  private readonly failed = signal<string | null>(null);
  /** Sobe a cada medida feita: o cache em memória não é um signal, e este faz o ajuste reler o que ele guarda. */
  private readonly measured = signal(0);

  private readonly declared = computed(() => iconSource(this.shortcut().iconDataUri));
  protected readonly source = computed(() => {
    const uri = this.declared();
    return uri && uri !== this.failed() ? uri : null;
  });

  /** O ajuste do ícone atual: `null` até ele ser medido (ou se não deu para medir). Um ícone já medido vem na hora. */
  protected readonly fit = computed(() => {
    const uri = this.source();
    this.measured();
    return uri ? (cachedIconFit(uri) ?? null) : null;
  });

  protected readonly hue = computed(() => `hue-${fallbackHue(this.shortcut().package)}`);
  protected readonly glyph = computed(() => fallbackGlyph(this.shortcut()));

  protected markFailed(uri: string): void {
    this.failed.set(uri);
  }

  /** A imagem carregou: mede uma única vez por ícone (a lista toda reaproveita o resultado guardado). */
  protected measure(event: Event, uri: string): void {
    if (cachedIconFit(uri) === undefined) {
      rememberIconFit(uri, fitFromImage(event.target as HTMLImageElement, this.readPixels));
    }
    this.measured.update((count) => count + 1);
  }
}
