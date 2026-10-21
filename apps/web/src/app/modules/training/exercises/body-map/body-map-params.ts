import type { ParamMap } from '@angular/router';
import { MuscleId, isMuscleId } from '../../domain/taxonomy';
import { BodyFace, faceFor } from './body-zones';

/**
 * O que o mapa guarda no endereço (`?face=back&muscle=lats`): a face à mostra e o músculo aberto no painel. É o que faz o
 * botão "voltar" da lista ou da ficha trazer o mapa como estava, na mesma face e com o painel aberto. Valor que o app não
 * conhece (escrito à mão) é ignorado.
 */
export interface BodyMapParams {
  readonly face: BodyFace;
  /** Músculo aberto no painel, ou vazio. */
  readonly muscle: MuscleId | '';
}

export function parseBodyMapParams(map: ParamMap): BodyMapParams {
  const rawMuscle = map.get('muscle') ?? '';
  const muscle = isMuscleId(rawMuscle) ? rawMuscle : '';
  const face: BodyFace = map.get('face') === 'back' ? 'back' : 'front';
  // Músculo pedido sem face (um link feito à mão) abre na face em que ele aparece.
  return { face: muscle && !map.has('face') ? faceFor(muscle, face) : face, muscle };
}

/** O texto da consulta do endereço; o que é o padrão (frente, nenhum músculo) fica de fora. */
export function toBodyMapQuery(params: BodyMapParams): string {
  const query = new URLSearchParams();
  if (params.face === 'back') query.set('face', 'back');
  if (params.muscle) query.set('muscle', params.muscle);
  return query.toString();
}
