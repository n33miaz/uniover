import type { LoadSuggestion, SuggestionReason } from '../domain/progress/suggest-load';
import type { SetIssueCode } from '../domain/session/session-model';
import { formatDuration, formatKg } from '../shell/format';

/** Textos que mais de uma peça do treino ao vivo usa. Ficam aqui para a frase ser a mesma em toda tela. */

/** "6–10", ou "10" quando a faixa é um número só. */
export function repsRangeText(from: number, to: number): string {
  return from === to ? `${from}` : `${from}–${to}`;
}

/** Relógio do descanso: "1:12" (minutos e segundos, o tempo que sobra arredondado para cima). */
export function clockText(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}`;
}

/** "42,5 kg × 8", "× 12" (só repetições) ou "45 s" (tempo): a série como se lê numa linha. */
export function setText(
  set: {
    readonly weightKg: number | null;
    readonly reps: number | null;
    readonly durationS: number | null;
  },
  recordType: string,
): string {
  if (recordType === 'time') return set.durationS === null ? '—' : formatDuration(set.durationS);
  if (recordType === 'reps_only') return set.reps === null ? '—' : `× ${set.reps}`;
  if (set.weightKg === null && set.reps === null) return '—';
  const load = set.weightKg === null ? '—' : formatKg(set.weightKg);
  return set.reps === null ? load : `${load} × ${set.reps}`;
}

/** "42,5 kg × 6–8": a sugestão do dia (carga e faixa de repetições). */
export function suggestionText(suggestion: LoadSuggestion): string {
  const reps = repsRangeText(suggestion.repsFrom, suggestion.repsTo);
  return suggestion.weightKg === null ? '' : `${formatKg(suggestion.weightKg)} × ${reps}`;
}

/** O motivo da sugestão, em uma frase (o app nunca baixa a carga sozinho: quem baixa é o dono). */
export function suggestionReasonText(reason: SuggestionReason): string {
  switch (reason) {
    case 'top-of-range':
      return $localize`:@@training.live.reason.top:Você fechou o topo da faixa na última vez, então sobe um degrau de carga.`;
    case 'rir-too-high':
      return $localize`:@@training.live.reason.easy:Você fechou o topo da faixa, mas o esforço informado foi leve (sobravam mais de duas repetições). A carga fica por mais um treino.`;
    case 'within-range':
      return $localize`:@@training.live.reason.within:Você ficou dentro da faixa, mas sem fechar o topo. A carga fica; busque mais repetições.`;
    case 'below-floor':
      return $localize`:@@training.live.reason.below:Alguma série ficou abaixo da faixa. A carga fica até as repetições voltarem; o app nunca baixa a carga sozinho.`;
    case 'no-history':
      return '';
  }
}

/** O que está errado na série, na voz da tela (o repositório devolve só o código). */
export function setIssueText(code: SetIssueCode): string {
  switch (code) {
    case 'weight-required':
      return $localize`:@@training.live.issue.weight-required:Informe a carga para concluir a série.`;
    case 'reps-required':
      return $localize`:@@training.live.issue.reps-required:Informe as repetições para concluir a série.`;
    case 'duration-required':
      return $localize`:@@training.live.issue.duration-required:Informe a duração para concluir a série.`;
    case 'weight-range':
      return $localize`:@@training.live.issue.weight-range:A carga precisa estar entre 0 e 99.999 kg, com até duas casas.`;
    case 'reps-range':
      return $localize`:@@training.live.issue.reps-range:As repetições precisam estar entre 0 e 999.`;
    case 'duration-range':
      return $localize`:@@training.live.issue.duration-range:A duração precisa ter no máximo 24 horas.`;
    case 'note-length':
      return $localize`:@@training.live.issue.note-length:A anotação passa de 300 caracteres.`;
    default:
      return $localize`:@@training.live.issue.other:Confira os valores da série.`;
  }
}

const dayFormat = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const rangeDayFormat = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** "Terça-feira, 20 de outubro": o dia de um instante, no fuso do aparelho, com a primeira letra maiúscula. */
export function dayLabel(timestamp: number): string {
  const text = dayFormat.format(timestamp);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "19 a 25 de outubro" (ou "28 de setembro a 4 de outubro"): os dias da semana, a partir das datas `AAAA-MM-DD`. */
export function weekRangeLabel(startKey: string, endKey: string): string {
  const at = (key: string) => new Date(`${key}T00:00:00Z`);
  const start = at(startKey);
  const end = at(endKey);
  if (start.getUTCMonth() === end.getUTCMonth()) {
    const month = rangeDayFormat.format(end).replace(/^\d+ de /, '');
    return $localize`:@@training.today.week-range:${start.getUTCDate()}:from: a ${end.getUTCDate()}:to: de ${month}:month:`;
  }
  const from = rangeDayFormat.format(start);
  const to = rangeDayFormat.format(end);
  return $localize`:@@training.today.week-range-months:${from}:from: a ${to}:to:`;
}

/** "5 exercícios · 16 séries · cerca de 55 min": o resumo de uma rotina (a duração é estimada e diz "cerca de"). */
export function routineSummary(routine: {
  readonly exercises: number;
  readonly sets: number;
  readonly minutes: number | null;
}): string {
  const exercises = routine.exercises;
  const sets = routine.sets;
  const parts = [
    exercises === 1
      ? $localize`:@@training.today.exercises-one:1 exercício`
      : $localize`:@@training.today.exercises-many:${exercises}:count: exercícios`,
    sets === 1
      ? $localize`:@@training.today.sets-one:1 série`
      : $localize`:@@training.today.sets-many:${sets}:count: séries`,
  ];
  if (routine.minutes !== null) {
    const minutes = routine.minutes;
    parts.push($localize`:@@training.today.minutes:cerca de ${minutes}:minutes: min`);
  }
  return parts.join(' · ');
}

/** O nome compacto da rotina no topo do registro: identifica o treino sem disputar espaço com os controles da série. */
export function liveRoutineName(name: string): string {
  const separator = name.indexOf(' · ');
  if (separator < 0) return name;
  const prefix = name.slice(0, separator);
  const detail = name
    .slice(separator + 3)
    .replace(/ e /g, ' ')
    .toLocaleLowerCase('pt-BR');
  return `${prefix} - ${detail}`;
}

/** "3 séries aguardando envio": as séries do treino que ainda não chegaram ao servidor; `null` quando não há nenhuma. */
export function awaitingSetsText(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? $localize`:@@training.live.awaiting-one:1 série aguardando envio`
    : $localize`:@@training.live.awaiting-many:${count}:count: séries aguardando envio`;
}

/** "há 3 h": há quanto tempo o treino de outro aparelho foi aberto. */
export function ageLabel(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  if (hours < 1) return $localize`:@@training.today.age-minutes:há menos de 1 h`;
  if (hours < 48) return $localize`:@@training.today.age-hours:há ${hours}:hours: h`;
  const days = Math.floor(hours / 24);
  return $localize`:@@training.today.age-days:há ${days}:days: dias`;
}
