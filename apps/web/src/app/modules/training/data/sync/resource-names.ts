/**
 * Os nomes estáveis dos recursos sincronizáveis (a chave do cursor na tabela `syncState`: nunca mude um valor depois de
 * publicado). Ficam num lugar só para o recurso e quem espera por ele (`FIRST_PULL_NEEDS`) usarem o mesmo símbolo: um nome
 * errado deixa de compilar em vez de esperar o prazo inteiro sem motivo.
 */
export const RESOURCE_NAMES = {
  exercises: 'exercises',
  routines: 'routines',
  program: 'program',
  sessions: 'sessions',
  sets: 'sets',
  goals: 'goals',
  bodyEntries: 'bodyEntries',
  bodyProfile: 'bodyProfile',
  calendarEntries: 'calendarEntries',
} as const;
