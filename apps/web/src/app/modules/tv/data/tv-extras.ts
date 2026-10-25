import type { TvIconName } from '../ui/tv-icon';
import { TvKey, TvSummary } from './tv-types';

/** Cor de uma tecla colorida: o botão mostra um disco dela, sem texto. */
export type TvExtraColor = 'red' | 'green' | 'yellow' | 'blue';

/** Um botão extra do controle: o que o torna escolhível em Personalizar e, o que sobra, entra em "Mais botões". */
export interface TvExtraKey {
  readonly key: TvKey;
  /** Nome completo (leitor de tela, lista de Personalizar e "Mais botões"). */
  readonly label: string;
  /** Rótulo curto dentro do botão redondo, quando não há ícone nem cor. */
  readonly short: string;
  readonly icon?: TvIconName;
  readonly color?: TvExtraColor;
}

/**
 * Os botões extras que o app sabe mostrar, **na ordem de importância**: é a ordem em que preenchem os espaços vazios da
 * tela principal quando a pessoa não escolheu nenhum. Só aparecem os que a TV declara ter (`tv.key.<TECLA>` no `hello` do
 * agente), com uma exceção: a Fonte (`INPUT`) já existia no contrato antes da declaração e toda TV conhecida a tem, então
 * conta como suportada mesmo para um agente mais velho.
 */
export const EXTRA_KEYS: readonly TvExtraKey[] = [
  { key: 'INPUT', label: $localize`:@@tv.extra.input:Fonte`, short: '', icon: 'input' },
  {
    key: 'GUIDE',
    label: $localize`:@@tv.extra.guide:Guia`,
    short: $localize`:@@tv.extra.guide.short:Guia`,
  },
  {
    key: 'INFO',
    label: $localize`:@@tv.extra.info:Informações`,
    short: $localize`:@@tv.extra.info.short:Info`,
  },
  {
    key: 'TOOLS',
    label: $localize`:@@tv.extra.tools:Ferramentas`,
    short: $localize`:@@tv.extra.tools.short:Ferram.`,
  },
  {
    key: 'CHANNEL_LIST',
    label: $localize`:@@tv.extra.channel-list:Lista de canais`,
    short: $localize`:@@tv.extra.channel-list.short:Lista`,
  },
  {
    key: 'EXIT',
    label: $localize`:@@tv.extra.exit:Sair`,
    short: $localize`:@@tv.extra.exit.short:Sair`,
  },
  {
    key: 'PREVIOUS_CHANNEL',
    label: $localize`:@@tv.extra.previous-channel:Canal anterior`,
    short: $localize`:@@tv.extra.previous-channel.short:Últ.`,
  },
  {
    key: 'SUBTITLE',
    label: $localize`:@@tv.extra.subtitle:Legendas`,
    short: $localize`:@@tv.extra.subtitle.short:Leg.`,
  },
  { key: 'PLAY', label: $localize`:@@tv.extra.play:Reproduzir`, short: '', icon: 'play' },
  { key: 'PAUSE', label: $localize`:@@tv.extra.pause:Pausar`, short: '', icon: 'pause' },
  { key: 'STOP', label: $localize`:@@tv.extra.stop:Parar`, short: '', icon: 'stop' },
  { key: 'REWIND', label: $localize`:@@tv.extra.rewind:Retroceder`, short: '', icon: 'rewind' },
  {
    key: 'FAST_FORWARD',
    label: $localize`:@@tv.extra.fast-forward:Avançar`,
    short: '',
    icon: 'forward',
  },
  {
    key: 'ASPECT',
    label: $localize`:@@tv.extra.aspect:Tamanho da imagem`,
    short: $localize`:@@tv.extra.aspect.short:Tela`,
  },
  {
    key: 'SLEEP',
    label: $localize`:@@tv.extra.sleep:Desligar em...`,
    short: $localize`:@@tv.extra.sleep.short:Timer`,
  },
  {
    key: 'E_MANUAL',
    label: $localize`:@@tv.extra.manual:Manual da TV`,
    short: $localize`:@@tv.extra.manual.short:Manual`,
  },
  { key: 'RED', label: $localize`:@@tv.extra.red:Vermelho`, short: '', color: 'red' },
  { key: 'GREEN', label: $localize`:@@tv.extra.green:Verde`, short: '', color: 'green' },
  { key: 'YELLOW', label: $localize`:@@tv.extra.yellow:Amarelo`, short: '', color: 'yellow' },
  { key: 'BLUE', label: $localize`:@@tv.extra.blue:Azul`, short: '', color: 'blue' },
];

const EXTRA_BY_KEY: ReadonlyMap<string, TvExtraKey> = new Map(
  EXTRA_KEYS.map((extra) => [extra.key, extra]),
);

/** Prefixo das capacidades de tecla que o agente declara (`tv.key.GUIDE`). */
const KEY_CAPABILITY_PREFIX = 'tv.key.';

/** Quantos extras a tela principal comporta (duas fileiras de quatro): o resto fica em "Mais botões". */
export const MAIN_EXTRAS_MAX = 8;

/** A tecla é um botão extra conhecido? (valida o que veio guardado no aparelho.) */
export function isExtraKey(value: unknown): value is TvKey {
  return typeof value === 'string' && EXTRA_BY_KEY.has(value);
}

/**
 * Os botões extras que a TV tem, na ordem de importância. Sem informação da TV (lista que não chegou, agente desligado)
 * vale só a Fonte, que o contrato antigo já trazia: ofertar teclas que a TV talvez não tenha seria pior do que não ofertar.
 */
export function supportedExtras(tv: TvSummary | null): readonly TvExtraKey[] {
  const declared = new Set(
    (tv?.capabilities ?? [])
      .filter((capability) => capability.startsWith(KEY_CAPABILITY_PREFIX))
      .map((capability) => capability.slice(KEY_CAPABILITY_PREFIX.length)),
  );
  declared.add('INPUT');
  return EXTRA_KEYS.filter((extra) => declared.has(extra.key));
}

export interface ExtrasRequest {
  /** Quantos botões redondos fixos há (voltar, início, menu, teclado, mídia...). */
  readonly base: number;
  /** Colunas da grade dos botões redondos. */
  readonly columns: number;
  readonly supported: readonly TvExtraKey[];
  /** A escolha da pessoa, na ordem; `null` deixa tudo por conta do preenchimento automático. */
  readonly chosen: readonly string[] | null;
}

/**
 * Os extras da tela principal. A grade **nunca** fica com um espaço vazio: depois dos escolhidos, completa-se a última
 * fileira com os mais importantes que a TV tem e ainda não aparecem. Se a TV não tem botões que bastem, tiram-se os
 * últimos escolhidos até a conta fechar (o que sobra continua em "Mais botões"). Sem escolha, só o preenchimento.
 */
export function mainExtras(request: ExtrasRequest): readonly TvExtraKey[] {
  const { base, columns, supported } = request;
  const byKey = new Map(supported.map((extra) => [extra.key, extra]));
  const chosen: TvExtraKey[] = [];
  for (const name of request.chosen ?? []) {
    const extra = byKey.get(name as TvKey);
    if (extra && !chosen.includes(extra)) chosen.push(extra);
    if (chosen.length === MAIN_EXTRAS_MAX) break;
  }
  const missing = (count: number) => (columns - ((base + count) % columns)) % columns;
  const filler = supported.filter((extra) => !chosen.includes(extra));
  const shown = [...chosen, ...filler.slice(0, missing(chosen.length))];
  // Sem escolha da pessoa e sem teclas que bastem para fechar a fileira (um agente antigo só declara a Fonte), o que
  // há fica na tela e a grade muda de colunas para fechar (ver `fitColumns`); com escolhas, quem não fecha sai.
  const adapts = chosen.length === 0 && fitColumns(base + shown.length, columns) !== null;
  while (!adapts && shown.length > 0 && missing(shown.length) !== 0) shown.pop();
  return shown;
}

/**
 * Em quantas colunas `total` botões fecham sem espaço vazio: as pedidas, ou menos (a partir das pedidas, até duas).
 * `null` quando nenhuma serve.
 */
export function fitColumns(total: number, columns: number): number | null {
  for (let candidate = columns; candidate >= 2; candidate--) {
    if (total % candidate === 0) return candidate;
  }
  return null;
}
