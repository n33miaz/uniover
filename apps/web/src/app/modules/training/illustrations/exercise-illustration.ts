import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { illustrationFor, illustrationUrl } from './illustration-map';
import { PrefersReducedMotion } from './prefers-reduced-motion';

/** Estado que o componente informa ao chamador: há ilustração, ou não há (e ele mostra só o texto). */
export type IllustrationState = 'ready' | 'missing';

/** Tempo entre uma pose e a outra. */
export const FRAME_INTERVAL_MS = 1000;

/**
 * Mostra as duas poses (início e fim do movimento) de um exercício, alternando a cada segundo, sobre um cartão claro:
 * os arquivos são desenhos de linha em fundo branco e não são recoloridos para o tema escuro (seriam uma adaptação).
 * Com `prefers-reduced-motion: reduce` nada se move: aparece a primeira pose e um botão troca de posição.
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
  protected readonly animated = computed(
    () => this.entry() !== undefined && !this.motion.reduced(),
  );
  /** Pose à vista (0 = início, 1 = fim). Volta para a primeira quando o exercício muda. */
  protected readonly frame = linkedSignal<string, 0 | 1>({
    source: this.slug,
    computation: () => 0,
  });

  constructor() {
    effect(() => this.stateChange.emit(this.entry() ? 'ready' : 'missing'));
    effect((onCleanup) => {
      if (!this.animated()) return;
      const timer = setInterval(() => this.flip(), FRAME_INTERVAL_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected altText(index: number): string {
    const name = this.name();
    const pose = index + 1;
    return $localize`:@@training.art.alt:${name}:name:, posição ${pose}:pose: de 2`;
  }

  protected flip(): void {
    this.frame.update((current) => (current === 0 ? 1 : 0));
  }
}
