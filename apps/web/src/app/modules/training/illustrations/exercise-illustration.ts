import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { illustrationFor, illustrationUrl } from './illustration-map';
import { PrefersReducedMotion } from './prefers-reduced-motion';

/** Estado que o componente informa ao chamador: há ilustração, ou não há (e ele mostra só o texto). */
export type IllustrationState = 'ready' | 'missing';

/** Tempo entre uma pose e a outra. */
export const FRAME_INTERVAL_MS = 1500;
/** Quanto tempo a ilustração alterna sozinha ao aparecer; depois para na pose em que estiver. */
export const AUTO_RUN_MS = 30_000;
/** Quanto tempo ela volta a alternar depois de um toque. */
export const TAP_RUN_MS = 120_000;

/**
 * Mostra as duas poses (início e fim do movimento) de um exercício, alternando sozinha com uma transição suave, sobre um
 * cartão claro: os arquivos são desenhos de linha em fundo branco e não são recoloridos para o tema escuro. As duas poses
 * ocupam a mesma caixa. A animação para depois de ~30 s; um toque na ilustração a retoma por ~2 min (e já troca a pose).
 * Com `prefers-reduced-motion: reduce` nada se move sozinho: aparece a primeira pose e o toque troca de posição.
 *
 * Figura de uma pose só (Open Exercise Art): aparece parada, sem botão e sem alternar; não se inventa a segunda pose.
 *
 * Sem ilustração segura para o `slug`, não desenha imagem nenhuma e emite `missing`; quem usa o componente mostra
 * o texto (músculo e equipamento). Nunca se cai na figura de outro exercício.
 */
@Component({
  selector: 'app-exercise-illustration',
  templateUrl: './exercise-illustration.html',
  styleUrl: './exercise-illustration.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseIllustration {
  private readonly motion = inject(PrefersReducedMotion);

  /** `slug` do exercício no catálogo. */
  readonly slug = input.required<string>();
  /** Nome do exercício, como a tela o mostra (entra no texto alternativo). */
  readonly name = input.required<string>();
  /** Emite `ready` ou `missing` toda vez que o `slug` muda (e na primeira leitura). */
  readonly stateChange = output<IllustrationState>();

  protected readonly entry = computed(() => illustrationFor(this.slug()));
  protected readonly sources = computed(
    () => this.entry()?.frames.map((file) => illustrationUrl(file)) ?? [],
  );
  /** Só há o que alternar quando a figura tem as duas poses; com uma só ela fica parada. */
  protected readonly twoPoses = computed(() => (this.entry()?.frames.length ?? 0) === 2);
  protected readonly animated = computed(() => this.twoPoses() && !this.motion.reduced());
  /** Pose à vista (0 = início, 1 = fim). Volta para a primeira quando o exercício muda. */
  protected readonly frame = linkedSignal<string, 0 | 1>({
    source: this.slug,
    computation: () => 0,
  });

  /** Cada toque abre uma nova janela de animação (o número troca para o efeito recomeçar). */
  private readonly run = signal({ id: 0, ms: AUTO_RUN_MS });

  protected readonly label = computed(() => {
    const name = this.name();
    if (!this.twoPoses()) return $localize`:@@training.art.single:${name}:name:, ilustração`;
    return this.motion.reduced()
      ? $localize`:@@training.art.toggle:${name}:name:, trocar de posição`
      : $localize`:@@training.art.replay:${name}:name:, repetir a animação`;
  });

  constructor() {
    effect(() => this.stateChange.emit(this.entry() ? 'ready' : 'missing'));
    effect((onCleanup) => {
      // Exercício novo recomeça a janela de ~30 s.
      this.slug();
      const { ms } = this.run();
      if (!this.animated()) return;
      const timer = setInterval(() => this.flip(), FRAME_INTERVAL_MS);
      const stop = setTimeout(() => clearInterval(timer), ms);
      onCleanup(() => {
        clearInterval(timer);
        clearTimeout(stop);
      });
    });
  }

  /** O toque troca a pose já; sem movimento reduzido, ainda retoma a alternância por mais tempo. */
  protected tap(): void {
    if (!this.twoPoses()) return;
    this.flip();
    if (this.animated()) this.run.update((current) => ({ id: current.id + 1, ms: TAP_RUN_MS }));
  }

  protected flip(): void {
    this.frame.update((current) => (current === 0 ? 1 : 0));
  }
}
