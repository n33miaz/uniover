/**
 * Aceleração do ponteiro: o mesmo deslize rápido vai mais longe que o lento, como num touchpad de verdade. A função é pura
 * (números entrando e saindo) para ser testada sem tela; o `PointerAccelerator` guarda só a sobra fracionária dos pixels, para
 * deslizes lentos não perderem movimento por arredondamento.
 */
export interface AccelerationConfig {
  /** Quanto cada pixel do dedo vale com o dedo quase parado. */
  readonly baseGain: number;
  /** O quanto o ganho cresce a cada pixel por milissegundo de velocidade. */
  readonly slope: number;
  /** O ganho nunca passa disto, por mais rápido que o dedo ande. */
  readonly maxGain: number;
}

export const DEFAULT_ACCELERATION: AccelerationConfig = { baseGain: 1.3, slope: 1.4, maxGain: 4.2 };

/** O ganho para uma velocidade em pixels por milissegundo (nunca abaixo do base, nunca acima do teto). */
export function gainFor(speedPxPerMs: number, config: AccelerationConfig = DEFAULT_ACCELERATION) {
  const speed = Number.isFinite(speedPxPerMs) ? Math.max(0, speedPxPerMs) : 0;
  return Math.min(config.maxGain, config.baseGain + config.slope * speed);
}

export interface PointerDelta {
  readonly dx: number;
  readonly dy: number;
}

/** Converte deslizes do dedo em passos do ponteiro, inteiros, guardando a sobra fracionária para o próximo. */
export class PointerAccelerator {
  private remainderX = 0;
  private remainderY = 0;

  constructor(private readonly config: AccelerationConfig = DEFAULT_ACCELERATION) {}

  /**
   * `elapsedMs` é o tempo desde o movimento anterior do mesmo dedo; zero ou negativo conta como o menor intervalo possível.
   * `config` troca a curva só nesta chamada (a sensibilidade escolhida pela pessoa).
   */
  apply(
    dx: number,
    dy: number,
    elapsedMs: number,
    config: AccelerationConfig = this.config,
  ): PointerDelta {
    const distance = Math.hypot(dx, dy);
    const gain = gainFor(distance / Math.max(1, elapsedMs), config);
    const wantedX = dx * gain + this.remainderX;
    const wantedY = dy * gain + this.remainderY;
    const stepX = Math.trunc(wantedX);
    const stepY = Math.trunc(wantedY);
    this.remainderX = wantedX - stepX;
    this.remainderY = wantedY - stepY;
    return { dx: stepX, dy: stepY };
  }

  /** Zera a sobra (um dedo novo não herda a fração do anterior). */
  reset(): void {
    this.remainderX = 0;
    this.remainderY = 0;
  }
}

/**
 * A sensibilidade do ponteiro que a pessoa escolhe, num controle deslizante de 1 a 7. O Windows já aplica a própria aceleração
 * ao movimento relativo que o agente envia ("aprimorar a precisão do ponteiro"); por isso o padrão (4, o meio) é 1 pixel do
 * dedo para 1 do ponteiro, sem curva por cima. Os níveis de antes ficaram no meio da escala: Baixa é o 2, Normal o 4, Alta o 6.
 * A "Acelerada" de antes virou o interruptor `acceleration` no nível 5 (a curva do app, mais rápida com o dedo veloz).
 */
export type SensitivityLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = [1, 2, 3, 4, 5, 6, 7];
/** O nível do meio: o padrão do ponteiro e da rolagem. */
export const DEFAULT_LEVEL: SensitivityLevel = 4;

/** O ganho de cada nível do ponteiro (o índice é o nível menos 1). */
export const POINTER_GAINS: readonly number[] = [0.5, 0.7, 0.85, 1, 1.3, 1.6, 2.1];

/** O valor guardado é um nível válido (um inteiro de 1 a 7). */
export function isSensitivityLevel(value: unknown): value is SensitivityLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

/** As escolhas de antes do controle deslizante, guardadas como texto: viram o nível equivalente. */
export type LegacyPointerSensitivity = 'low' | 'normal' | 'high' | 'boosted';

export const LEGACY_POINTER_LEVEL: Readonly<
  Record<
    LegacyPointerSensitivity,
    { readonly level: SensitivityLevel; readonly acceleration: boolean }
  >
> = {
  low: { level: 2, acceleration: false },
  normal: { level: 4, acceleration: false },
  high: { level: 6, acceleration: false },
  // A curva do app parte de 1,3 por pixel: é o nível 5 com a aceleração ligada, exatamente.
  boosted: { level: 5, acceleration: true },
};

const flat = (gain: number): AccelerationConfig => ({ baseGain: gain, slope: 0, maxGain: gain });

/**
 * A curva de um nível: plana (o ganho do nível) ou, com `acceleration`, a curva do app escalada para partir do ganho do nível
 * (no nível 5 é a curva do app sem mudança).
 */
export function accelerationFor(level: SensitivityLevel, acceleration = false): AccelerationConfig {
  const gain = POINTER_GAINS[level - 1];
  if (!acceleration) return flat(gain);
  if (gain === DEFAULT_ACCELERATION.baseGain) return DEFAULT_ACCELERATION;
  const scale = gain / DEFAULT_ACCELERATION.baseGain;
  return {
    baseGain: gain,
    slope: DEFAULT_ACCELERATION.slope * scale,
    maxGain: DEFAULT_ACCELERATION.maxGain * scale,
  };
}

/** O ganho de cada nível da rolagem (separado do ponteiro; o índice é o nível menos 1). */
export const SCROLL_GAINS: readonly number[] = [0.4, 0.6, 0.8, 1, 1.3, 1.6, 2.2];

export type LegacyScrollSensitivity = 'low' | 'normal' | 'high';

export const LEGACY_SCROLL_LEVEL: Readonly<Record<LegacyScrollSensitivity, SensitivityLevel>> = {
  low: 2,
  normal: 4,
  high: 6,
};

/** O quanto a rolagem rende por pixel do dedo no nível escolhido. */
export function scrollGainFor(level: SensitivityLevel): number {
  return SCROLL_GAINS[level - 1];
}

/** Um clique da roda do Windows, em unidades de roda. */
export const WHEEL_UNIT = 120;

/**
 * Rolagem: quanto cada pixel do deslize vale conforme a velocidade do dedo (devagar rola fino, rápido rola longe, até o
 * teto). Os valores são o ganho sobre os 40 px por clique.
 */
export const SCROLL_ACCELERATION: AccelerationConfig = { baseGain: 1, slope: 0.9, maxGain: 3 };

/**
 * Deslize de dois dedos em pixels vira rolagem em unidades de roda, proporcional à velocidade do dedo. Segue o padrão do
 * Windows: deslizar para baixo rola para baixo (valor negativo na roda); `invert` troca o sentido dos dois eixos (a rolagem
 * "natural" do celular). Cerca de 40 px de deslize valem um clique da roda; a sobra fracionária fica para o passo seguinte.
 */
export class ScrollAccelerator {
  private remainderX = 0;
  private remainderY = 0;

  constructor(
    private readonly config: AccelerationConfig = SCROLL_ACCELERATION,
    private readonly pxPerNotch = 40,
  ) {}

  apply(
    swipeX: number,
    swipeY: number,
    elapsedMs: number,
    invert = false,
    sensitivity = 1,
  ): { scrollX: number; scrollY: number } {
    const speed = Math.hypot(swipeX, swipeY) / Math.max(1, elapsedMs);
    const unit =
      (WHEEL_UNIT / this.pxPerNotch) *
      gainFor(speed, this.config) *
      sensitivity *
      (invert ? -1 : 1);
    const wantedX = swipeX * unit + this.remainderX;
    const wantedY = -swipeY * unit + this.remainderY;
    const stepX = Math.trunc(wantedX);
    const stepY = Math.trunc(wantedY);
    this.remainderX = wantedX - stepX;
    this.remainderY = wantedY - stepY;
    return { scrollX: stepX, scrollY: stepY };
  }

  reset(): void {
    this.remainderX = 0;
    this.remainderY = 0;
  }
}
