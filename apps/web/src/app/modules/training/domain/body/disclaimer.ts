/**
 * Quais números do corpo pedem o aviso de saúde. O TEXTO do aviso é da tela (i18n); aqui só se diz quando ele é exigido:
 * nas telas de peso, gordura e calorias (e nos números que saem de fórmula), nunca em medida pura nem em foto.
 */
export type HealthFigure =
  'weight' | 'trend' | 'bodyFat' | 'basalRate' | 'calorieTarget' | 'measurements' | 'photos';

const WITH_DISCLAIMER: ReadonlySet<HealthFigure> = new Set([
  'weight',
  'trend',
  'bodyFat',
  'basalRate',
  'calorieTarget',
]);

/** O número pede o aviso ("estimativa, não é orientação médica, nutricional nem de educador físico")? */
export function requiresDisclaimer(kind: HealthFigure): boolean {
  return WITH_DISCLAIMER.has(kind);
}
