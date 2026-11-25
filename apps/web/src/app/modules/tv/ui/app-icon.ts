import { Component, InjectionToken, computed, inject, input, signal } from '@angular/core';
import {
  AppIconSubject,
  fallbackGlyph,
  fallbackHue,
  iconSource,
  samsungIconSource,
  systemAppGlyph,
} from './app-icon-source';
import { TvIcon } from './tv-icon';
import {
  IconPixelReader,
  cachedIconFit,
  fitFromImage,
  readIconPixels,
  rememberIconFit,
} from './app-icon-fit';
import { knownApp } from '../data/tv-suggestions';

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
 * pacote. Um app do sistema da TV (Configurações) mostra o desenho do UniOver sobre a placa dos círculos do sistema, o
 * mesmo da TV. É decorativo: quem o usa dá o nome ao botão (`aria-label` ou o texto ao lado). O tamanho vem da variável
 * `--tile`, definida por quem o usa.
 */
@Component({
  selector: 'app-tv-app-icon',
  templateUrl: './app-icon.html',
  styleUrl: './app-icon.css',
  imports: [TvIcon],
  host: {
    '[style.background-color]': 'fit()?.background ?? null',
    '[class.system]': 'systemGlyph() !== null',
  },
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

  /** App do sistema da TV (Configurações): o desenho do UniOver, igual ao círculo do TV Livre, no lugar da arte da TV. */
  protected readonly systemGlyph = computed(() => systemAppGlyph(this.shortcut().package));

  private readonly declared = computed(
    () => iconSource(this.shortcut().iconDataUri) ?? samsungIconSource(this.shortcut().package),
  );

  /** O ajuste do ícone declarado: `null` até ele ser medido (ou se não deu para medir). Um ícone já medido vem na hora. */
  private readonly measuredFit = computed(() => {
    const uri = this.declared();
    this.measured();
    return uri ? (cachedIconFit(uri) ?? null) : null;
  });

  /**
   * A imagem a mostrar. Nunca um azulejo vazio: sem imagem, com imagem que falhou ao carregar ou com imagem sem tinta
   * nenhuma (toda transparente), vale a inicial do app (`null` aqui).
   */
  protected readonly source = computed(() => {
    const uri = this.declared();
    return uri && uri !== this.failed() && this.measuredFit()?.blank !== true ? uri : null;
  });

  protected readonly fit = computed(() => (this.source() ? this.measuredFit() : null));

  /**
   * Marca conhecida sem ícone: a reserva usa uma cor parecida com a da marca (e a tinta que contrasta com ela), nunca
   * um logotipo. Os demais apps ficam com a cor estável do pacote.
   */
  protected readonly brand = computed(() => knownApp(this.shortcut().package));
  protected readonly hue = computed(() =>
    this.brand() ? 'brand' : `hue-${fallbackHue(this.shortcut().package)}`,
  );
  protected readonly glyph = computed(() => this.brand()?.mark ?? fallbackGlyph(this.shortcut()));

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
