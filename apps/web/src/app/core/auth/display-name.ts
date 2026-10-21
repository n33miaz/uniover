import { ApiProblem, problemOf } from './api-problem';
import { describeWait } from './countdown';

/** Teto de caracteres do nome de exibição na API (conta pontos de código Unicode, não unidades UTF-16). */
export const MAX_DISPLAY_NAME = 60;

/**
 * Teto de digitação do campo. Folgado de propósito: a API conta pontos de código (um emoji vale 1 e ocupa 2 unidades do
 * navegador), então um `maxlength` de 60 cortaria um nome que a API aceita. Este só impede colar um texto gigante; o
 * limite de verdade aparece no contador e na mensagem do campo.
 */
export const DISPLAY_NAME_INPUT_LIMIT = 120;

/**
 * O nome como a API o conta: Unicode composto (NFC), sem espaços nas pontas e com as repetições de espaço reduzidas a
 * um. A contagem da tela e a conferência antes de enviar usam este texto, para dar o mesmo veredito do servidor.
 */
export function normalizeDisplayName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Quantos caracteres o nome tem para a API (pontos de código do texto normalizado). */
export function displayNameLength(raw: string): number {
  return Array.from(normalizeDisplayName(raw)).length;
}

export type DisplayNameIssue = 'empty' | 'too-long';

/** O que dá para saber sem ir ao servidor; o resto (caracteres invisíveis, por exemplo) é a API quem recusa. */
export function displayNameIssue(raw: string): DisplayNameIssue | null {
  const length = displayNameLength(raw);
  if (length === 0) return 'empty';
  return length > MAX_DISPLAY_NAME ? 'too-long' : null;
}

export function displayNameIssueText(issue: DisplayNameIssue): string {
  return issue === 'empty'
    ? $localize`:@@auth.name.empty:Escreva como devemos te chamar.`
    : $localize`:@@auth.name.too-long:O nome pode ter até ${MAX_DISPLAY_NAME}:max: caracteres.`;
}

/**
 * Como a tela conta o que sobrou para escrever: "12 de 60". Passando do limite o número continua verdadeiro (por
 * exemplo "63 de 60"), e a mensagem do campo diz o que fazer.
 */
export function displayNameCounterText(raw: string): string {
  const length = displayNameLength(raw);
  return $localize`:@@auth.name.counter:${length}:length: de ${MAX_DISPLAY_NAME}:max:`;
}

/** O que deu errado ao salvar o nome, já em texto: onde mostrar (`field` ou faixa) e o quê. */
export interface DisplayNameFailure {
  readonly kind: 'field' | 'network' | 'wait' | 'revoked' | 'failed';
  /** Mensagem do campo (só em `field`), a mesma que a API devolveu sob `displayName`. */
  readonly field: string | null;
  /** Texto da faixa de aviso (todos os tipos menos `field`). */
  readonly heading: string;
  readonly detail: string | null;
}

/** Procura as mensagens do campo sem depender da caixa da chave (`displayName` ou `DisplayName`). */
function fieldMessage(problem: ApiProblem): string | null {
  const entry = Object.entries(problem.fieldErrors).find(
    ([key]) => key.toLowerCase() === 'displayname',
  );
  return entry?.[1][0] ?? null;
}

/**
 * Lê o erro de `PATCH /me` e diz o que mostrar: 400 vira mensagem do campo (a da API; sem ela, uma genérica), 429 pede
 * para esperar o tempo do `Retry-After`, 403 é conta sem acesso, sem resposta é rede, o resto é falha do servidor.
 */
export function describeDisplayNameFailure(error: unknown): DisplayNameFailure {
  const problem = problemOf(error);
  if (problem?.status === 400) {
    const text =
      fieldMessage(problem) ??
      $localize`:@@auth.name.rejected:Esse nome não pode ser usado. Confira e tente de novo.`;
    return { kind: 'field', field: text, heading: text, detail: null };
  }
  if (problem?.status === 429) {
    const wait = problem.retryAfterSeconds;
    return {
      kind: 'wait',
      field: null,
      heading: $localize`:@@auth.name.rate-limited:Muitas tentativas seguidas.`,
      detail:
        wait === null
          ? $localize`:@@auth.name.rate-limited-detail:Espere um pouco antes de tentar de novo.`
          : $localize`:@@auth.name.rate-limited-wait:Espere ${describeWait(wait)}:wait: antes de tentar de novo.`,
    };
  }
  if (problem?.status === 403) {
    return {
      kind: 'revoked',
      field: null,
      heading: $localize`:@@auth.name.revoked:Esta conta não tem mais acesso.`,
      detail: $localize`:@@auth.name.revoked-detail:Quem administra o UniOver desligou o acesso. Fale com essa pessoa.`,
    };
  }
  if (problem?.isNetwork) {
    return {
      kind: 'network',
      field: null,
      heading: $localize`:@@auth.name.network:Sem conexão com o servidor.`,
      detail: $localize`:@@auth.name.network-detail:O nome não foi salvo. Verifique a sua internet e tente de novo.`,
    };
  }
  return {
    kind: 'failed',
    field: null,
    heading: $localize`:@@auth.name.failed:Não foi possível salvar agora.`,
    detail: $localize`:@@auth.name.failed-detail:Algo deu errado do nosso lado. Tente de novo em instantes.`,
  };
}
