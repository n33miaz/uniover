/**
 * O que a tela dos Atalhos da Siri sabe sobre as ações que a API aceita (`POST /api/v1/shortcuts/tv`): o código estável
 * de cada uma (o mesmo gravado na chave), o texto em linguagem de gente e o JSON que o app Atalhos precisa mandar.
 * Não existe "Ligar": nenhuma rota da API liga a TV, então a lista não promete o que o servidor não entrega.
 */

/** Cabeçalho que leva a chave. */
export const SIRI_HEADER = 'X-Atalho-Token';

/** Caminho da ordem; o endereço inteiro leva a origem do app. */
export const SIRI_PATH = '/api/v1/shortcuts/tv';

/** Quantas chaves ativas cada conta pode ter (o servidor recusa a 11ª). */
export const SIRI_MAX_KEYS = 10;

/** O texto que ocupa o lugar da chave quando ela já não pode ser mostrada. */
export const SIRI_TOKEN_PLACEHOLDER = '<sua chave>';

export type SiriGroup = 'power' | 'sound' | 'keys' | 'apps';

export interface SiriAction {
  /** Código gravado na chave: `power_off`, `volume_up`, `key:HOME`, `app:{id}`. */
  readonly code: string;
  readonly group: SiriGroup;
  /** Nome curto da ação, para a lista de escolhas. */
  readonly label: string;
  /** O nome sugerido para o atalho: é a frase que a pessoa diz à Siri ("E aí Siri, Desligar a TV"). */
  readonly phrase: string;
}

/** Os campos do JSON, na ordem em que o app Atalhos os pede. */
export interface SiriField {
  readonly name: string;
  readonly value: string;
}

export const SIRI_KEYS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'HOME', label: $localize`:@@settings.siri.key.home:Início` },
  { key: 'BACK', label: $localize`:@@settings.siri.key.back:Voltar` },
  { key: 'OK', label: $localize`:@@settings.siri.key.ok:OK` },
  { key: 'UP', label: $localize`:@@settings.siri.key.up:Cima` },
  { key: 'DOWN', label: $localize`:@@settings.siri.key.down:Baixo` },
  { key: 'LEFT', label: $localize`:@@settings.siri.key.left:Esquerda` },
  { key: 'RIGHT', label: $localize`:@@settings.siri.key.right:Direita` },
  { key: 'PLAY_PAUSE', label: $localize`:@@settings.siri.key.play-pause:Play e Pausa` },
];

/** As ações que não dependem de app: energia, som e teclas, na ordem da tela. */
export function fixedActions(): readonly SiriAction[] {
  return [
    {
      code: 'power_off',
      group: 'power',
      label: $localize`:@@settings.siri.power-off:Desligar a TV`,
      phrase: $localize`:@@settings.siri.power-off.phrase:Desligar a TV`,
    },
    {
      code: 'volume_up',
      group: 'sound',
      label: $localize`:@@settings.siri.volume-up:Aumentar o volume`,
      phrase: $localize`:@@settings.siri.volume-up.phrase:Aumentar o volume da TV`,
    },
    {
      code: 'volume_down',
      group: 'sound',
      label: $localize`:@@settings.siri.volume-down:Baixar o volume`,
      phrase: $localize`:@@settings.siri.volume-down.phrase:Baixar o volume da TV`,
    },
    {
      code: 'mute',
      group: 'sound',
      label: $localize`:@@settings.siri.mute:Mudo`,
      phrase: $localize`:@@settings.siri.mute.phrase:Mudo na TV`,
    },
    ...SIRI_KEYS.map(({ key, label }): SiriAction => ({
      code: `key:${key}`,
      group: 'keys',
      label,
      phrase: $localize`:@@settings.siri.key.phrase:Tecla ${label}:key: da TV`,
    })),
  ];
}

/** A ação de abrir um app da TV; `name` é o nome mostrado do atalho do app. */
export function appAction(id: string, name: string): SiriAction {
  return {
    code: `app:${id}`,
    group: 'apps',
    label: name,
    phrase: $localize`:@@settings.siri.app.phrase:Abrir ${name}:app: na TV`,
  };
}

/**
 * A ação de um código gravado na chave. App que a lista da TV já não traz vira "App" sem nome (a chave segue valendo
 * para o id dele); código desconhecido não tem ação (a tela não o mostra).
 */
export function actionOfCode(
  code: string,
  appNames: ReadonlyMap<string, string>,
): SiriAction | null {
  const fixed = fixedActions().find((action) => action.code === code);
  if (fixed) return fixed;
  if (code.startsWith('app:')) {
    const id = code.slice('app:'.length);
    return appAction(id, appNames.get(id) ?? $localize`:@@settings.siri.app.unknown:App`);
  }
  return null;
}

/** Os campos do JSON de uma ação: `tv` e `action` sempre; `key` ou `app` quando a ação os pede. */
export function fieldsOf(code: string, tvId: string): readonly SiriField[] {
  const tv: SiriField = { name: 'tv', value: tvId };
  if (code.startsWith('key:')) {
    return [
      tv,
      { name: 'action', value: 'key' },
      { name: 'key', value: code.slice('key:'.length) },
    ];
  }
  if (code.startsWith('app:')) {
    return [
      tv,
      { name: 'action', value: 'app' },
      { name: 'app', value: code.slice('app:'.length) },
    ];
  }
  return [tv, { name: 'action', value: code }];
}

/** O mesmo corpo como JSON de uma linha, para quem prefere colar o texto inteiro. */
export function bodyOf(code: string, tvId: string): string {
  return JSON.stringify(Object.fromEntries(fieldsOf(code, tvId).map((f) => [f.name, f.value])));
}

/** O endereço que o atalho chama, a partir da origem do app (ex.: `https://uniover.exemplo.com`). */
export function endpointUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${SIRI_PATH}`;
}

/**
 * O passo a passo de uma ação como texto corrido, para o botão "Copiar tudo": o que preencher no app Atalhos, na
 * ordem. Sem a chave (já escondida) o lugar dela fica marcado.
 */
export function instructionsText(
  action: SiriAction,
  origin: string,
  tvId: string,
  token: string | null,
): string {
  const lines = [
    $localize`:@@settings.siri.text.title:Atalho: ${action.phrase}:phrase:`,
    $localize`:@@settings.siri.text.action:No app Atalhos, adicione "Obter Conteúdo de URL" e preencha:`,
    $localize`:@@settings.siri.text.url:URL: ${endpointUrl(origin)}:url:`,
    $localize`:@@settings.siri.text.method:Método: POST`,
    $localize`:@@settings.siri.text.header:Cabeçalho: ${SIRI_HEADER}:header: = ${token ?? SIRI_TOKEN_PLACEHOLDER}:token:`,
    $localize`:@@settings.siri.text.body:Corpo da requisição: JSON`,
    ...fieldsOf(action.code, tvId).map((field) => `  ${field.name} = ${field.value}`),
  ];
  return lines.join('\n');
}

/** Validade escolhida na criação; `null` é sem prazo. */
export interface SiriExpiry {
  readonly days: number | null;
  readonly label: string;
}

export function expiryOptions(): readonly SiriExpiry[] {
  return [
    { days: null, label: $localize`:@@settings.siri.expiry.never:Sem prazo` },
    { days: 30, label: $localize`:@@settings.siri.expiry.30:30 dias` },
    { days: 90, label: $localize`:@@settings.siri.expiry.90:90 dias` },
    { days: 365, label: $localize`:@@settings.siri.expiry.365:1 ano` },
  ];
}
