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

  /** `elapsedMs` é o tempo desde o movimento anterior do mesmo dedo; zero ou negativo conta como o menor intervalo possível. */
  apply(dx: number, dy: number, elapsedMs: number): PointerDelta {
    const distance = Math.hypot(dx, dy);
    const gain = gainFor(distance / Math.max(1, elapsedMs), this.config);
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

/** Um clique da roda do Windows, em unidades de roda. */
export const WHEEL_UNIT = 120;

/**
 * Deslize de dois dedos em pixels vira rolagem em unidades de roda. Segue o padrão do Windows: deslizar para baixo rola
 * para baixo (valor negativo na roda). Cerca de 40 px de deslize valem um clique da roda.
 */
export function wheelFromSwipe(
  swipeX: number,
  swipeY: number,
  pxPerNotch = 40,
): { scrollX: number; scrollY: number } {
  const unit = WHEEL_UNIT / pxPerNotch;
  return { scrollX: Math.round(swipeX * unit), scrollY: Math.round(-swipeY * unit) };
}
