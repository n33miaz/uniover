/** Textos do mapa do corpo que mais de uma peça usa (a figura, a lista e o painel dizem os mesmos números do mesmo jeito). */

/** "1 exercício" · "41 exercícios". */
export function exercisesText(count: number): string {
  return count === 1
    ? $localize`:@@training.map.exercises-one:1 exercício`
    : $localize`:@@training.map.exercises-many:${count}:count: exercícios`;
}

/** As séries de trabalho da semana, dito como fato (zero não é alerta): "Nenhuma série nesta semana" · "12 séries nesta semana". */
export function weekSetsText(sets: number): string {
  if (sets === 0) return $localize`:@@training.map.sets-none:Nenhuma série nesta semana`;
  return sets === 1
    ? $localize`:@@training.map.sets-one:1 série nesta semana`
    : $localize`:@@training.map.sets-many:${sets}:sets: séries nesta semana`;
}

/** Só a palavra, para quem já mostra o número à parte: "exercício" · "exercícios". */
export function exercisesUnitText(count: number): string {
  return count === 1
    ? $localize`:@@training.map.unit-one:exercício`
    : $localize`:@@training.map.unit-many:exercícios`;
}
