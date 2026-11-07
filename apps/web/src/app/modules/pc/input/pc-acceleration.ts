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
 * A sensibilidade do ponteiro que a pessoa escolhe. O Windows já aplica a própria aceleração ao movimento relativo que o
 * agente envia ("aprimorar a precisão do ponteiro"); por isso o padrão é `normal`, 1 pixel do dedo para 1 do ponteiro, sem
 * curva por cima. `boosted` devolve a curva do app (mais rápido com o dedo veloz) para quem a prefere.
 */
export type PointerSensitivity = 'low' | 'normal' | 'high' | 'boosted';

export const POINTER_SENSITIVITIES: readonly PointerSensitivity[] = [
  'low',
  'normal',
  'high',
  'boosted',
];

const flat = (gain: number): AccelerationConfig => ({ baseGain: gain, slope: 0, maxGain: gain });

const SENSITIVITY_CONFIG: Readonly<Record<PointerSensitivity, AccelerationConfig>> = {
  low: flat(0.7),
  normal: flat(1),
  high: flat(1.6),
  boosted: DEFAULT_ACCELERATION,
};

export function accelerationFor(sensitivity: PointerSensitivity): AccelerationConfig {
  return SENSITIVITY_CONFIG[sensitivity];
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
  ): { scrollX: number; scrollY: number } {
    const speed = Math.hypot(swipeX, swipeY) / Math.max(1, elapsedMs);
    const unit = (WHEEL_UNIT / this.pxPerNotch) * gainFor(speed, this.config) * (invert ? -1 : 1);
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
