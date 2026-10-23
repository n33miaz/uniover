import type { TvShortcut } from './tv-types';

/**
 * Um app conhecido que a tela sugere como atalho numa TV ainda sem nenhum escolhido. É só uma sugestão: nada garante
 * que o app esteja instalado na TV. Só vira atalho de verdade se a lista que a TV informou trouxer esse app (pelo pacote
 * ou pelo nome publicado), porque a API não cria atalhos: ela só liga e desliga os que a TV listou.
 */
export interface TvSuggestedApp {
  /** Identificador estável (é o que se guarda em "sugestão removida"); nunca é mostrado. */
  readonly key: string;
  /** O nome da marca, o mesmo em qualquer idioma. */
  readonly label: string;
  /** Nomes pelos quais a TV pode publicar o app (além de `label`), comparados sem acento, caixa nem pontuação. */
  readonly aliases: readonly string[];
  /** Pacotes Android conhecidos do app para TV. */
  readonly packages: readonly string[];
}

/** Na ordem em que são oferecidas: as de uso mais comum primeiro, para a faixa curta mostrar as que mais servem. */
export const TV_SUGGESTED_APPS: readonly TvSuggestedApp[] = [
  {
    key: 'youtube',
    label: 'YouTube',
    aliases: [],
    packages: ['com.google.android.youtube.tv'],
  },
  { key: 'netflix', label: 'Netflix', aliases: [], packages: ['com.netflix.ninja'] },
  {
    key: 'prime-video',
    label: 'Prime Video',
    aliases: ['Amazon Prime Video'],
    packages: ['com.amazon.amazonvideo.livingroom'],
  },
  { key: 'max', label: 'Max', aliases: ['HBO Max'], packages: ['com.wbd.stream'] },
  {
    key: 'disney-plus',
    label: 'Disney+',
    aliases: ['Disney Plus'],
    packages: ['com.disney.disneyplus'],
  },
  { key: 'globoplay', label: 'Globoplay', aliases: [], packages: ['com.globo.globotv'] },
];

/** Largura de um azulejo da faixa de atalhos e o vão entre eles (os mesmos do CSS da faixa). */
export const SUGGESTION_TILE_PX = 60;
export const SUGGESTION_GAP_PX = 8;
/** Folga que a faixa guarda de sobra (soma das duas pontas), para as sugestões nunca encostarem nas bordas. */
export const SUGGESTION_SLACK_PX = 16;

/**
 * Quantas sugestões cabem na faixa, lado a lado e sem rolar, com folga: o que sobra da largura medida depois da folga,
 * dividido pelo azulejo mais o vão. Largura desconhecida (0, antes da primeira medida) não cabe nenhuma.
 */
export function suggestionCapacity(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  const room = width - SUGGESTION_SLACK_PX + SUGGESTION_GAP_PX;
  return Math.max(0, Math.floor(room / (SUGGESTION_TILE_PX + SUGGESTION_GAP_PX)));
}

/** Minúsculas, sem acento e só letras e números: "Disney+" e "disney" são o mesmo nome. */
function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** As sugestões que ainda valem (as que a pessoa não removeu), limitadas ao que cabe. */
export function pickSuggestions(
  dismissed: readonly string[],
  capacity: number,
): readonly TvSuggestedApp[] {
  return TV_SUGGESTED_APPS.filter((app) => !dismissed.includes(app.key)).slice(
    0,
    Math.max(0, capacity),
  );
}

/**
 * O atalho da TV que corresponde à sugestão, se a lista dela já o trouxer: instalado e com o pacote conhecido ou o
 * mesmo nome (o do dono, ou o que a TV publica). Comparação por igualdade do nome inteiro, para "YouTube" não pegar
 * "YouTube Kids".
 */
export function matchSuggestion(
  app: TvSuggestedApp,
  shortcuts: readonly TvShortcut[] | null,
): TvShortcut | null {
  if (!shortcuts) return null;
  const names = new Set([app.label, ...app.aliases].map(plain));
  return (
    shortcuts.find((shortcut) => {
      if (!shortcut.installed) return false;
      if (app.packages.includes(shortcut.package)) return true;
      return [shortcut.customLabel, shortcut.tvLabel].some(
        (name) => !!name && names.has(plain(name)),
      );
    }) ?? null
  );
}
