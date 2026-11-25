import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, linkedSignal } from '@angular/core';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { setHapticsEnabled } from '../input/haptics';
import {
  DEFAULT_LEVEL,
  LEGACY_POINTER_LEVEL,
  LEGACY_SCROLL_LEVEL,
  isSensitivityLevel,
  type LegacyPointerSensitivity,
  type LegacyScrollSensitivity,
  type SensitivityLevel,
} from '../input/pc-acceleration';

export interface PcPrefsValue {
  /**
   * Quanto o ponteiro anda por pixel do dedo, de 1 a 7; o padrão (4) é 1 para 1, sem curva própria (o Windows já acelera).
   * Guardado como número; a versão de antes guardava texto ("low", "high"...) e é lida como o nível equivalente.
   */
  readonly sensitivity: SensitivityLevel;
  /** A curva do app por cima do nível: o deslize rápido vai mais longe (a "Acelerada" de antes). */
  readonly acceleration: boolean;
  /**
   * A pessoa escolheu a aceleração no app (ligou ou desligou). Sem escolha, a do app segue a do Windows do PC
   * (`pointerAcceleration`); voltar ao padrão volta a seguir.
   */
  readonly accelerationChosen: boolean;
  /** O quanto a rolagem de dois dedos rende por pixel, de 1 a 7 (separado da sensibilidade do ponteiro). */
  readonly scrollSensitivity: SensitivityLevel;
  /** Rolagem "natural" (como no celular): o conteúdo acompanha o dedo. */
  readonly invertScroll: boolean;
  /** Arrastar com toque duplo: tocar de novo logo depois de um toque e andar segura o botão esquerdo. */
  readonly doubleTapDrag: boolean;
  /** Um toque curto de três dedos é o clique do meio. */
  readonly middleClick: boolean;
  /** Vibração curta nos toques (só onde o aparelho vibra). */
  readonly haptics: boolean;
  /** A pinça de dois dedos vira zoom no PC (só com um PC que entende o zoom; a rolagem de dois dedos segue igual). */
  readonly pinchZoom: boolean;
  /** Gestos de três dedos: andar juntos troca a janela (para os lados), mostra as janelas (para cima) ou a área de trabalho (para baixo). Desligados por padrão: três dedos seguem sendo só o clique do meio. */
  readonly threeFingerGestures: boolean;
  /** Mostra os botões Esquerdo, Arrastar e Direito embaixo da superfície (para quem não usa os gestos). */
  readonly clickButtons: boolean;
  /** Mantém a tela do aparelho acesa enquanto o touchpad está aberto. */
  readonly keepAwake: boolean;
  /**
   * Mostra, acima da barra, o que se digita no PC pelo teclado do celular. Só a escolha de mostrar fica guardada: o texto
   * nunca.
   */
  readonly showTyped: boolean;
  /**
   * O eco já passou pela volta ao padrão (ligado). Uma escolha "escondido" guardada antes dela volta a mostrar uma vez: o eco
   * escondido some sem a pessoa perceber, e quem o quiser escondido esconde de novo (e essa escolha fica).
   */
  readonly showTypedChecked: boolean;
  /** A dica de primeiro uso (os três gestos) já foi vista: some ao primeiro toque e não volta. */
  readonly hintSeen: boolean;
  /** O aviso do Vídeo ("o player precisa estar em foco") já foi visto: some ao primeiro toque de vídeo e não volta. */
  readonly videoHintSeen: boolean;
}

export const PC_PREFS_DEFAULTS: PcPrefsValue = {
  sensitivity: DEFAULT_LEVEL,
  acceleration: false,
  accelerationChosen: false,
  scrollSensitivity: DEFAULT_LEVEL,
  invertScroll: false,
  doubleTapDrag: false,
  middleClick: true,
  pinchZoom: true,
  threeFingerGestures: false,
  haptics: true,
  clickButtons: false,
  keepAwake: true,
  showTyped: true,
  showTypedChecked: true,
  hintSeen: false,
  videoHintSeen: false,
};

export const PC_PREFS_KEY = 'uniover.pc.prefs.v1';

/** Chave das escolhas de uma conta neste aparelho (cada pessoa tem as suas). */
export function pcPrefsStorageKey(accountId: string): string {
  return `${PC_PREFS_KEY}.${encodeURIComponent(accountId)}`;
}

/**
 * Valida o que veio do armazenamento campo a campo: um valor estragado, ou um campo que a versão guardada ainda não
 * tinha, volta ao padrão sem derrubar o outro.
 */
type BooleanPref = {
  [K in keyof PcPrefsValue]: PcPrefsValue[K] extends boolean ? K : never;
}[keyof PcPrefsValue];

function parsePrefs(raw: unknown): PcPrefsValue {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const flag = (name: BooleanPref): boolean => {
    const found = stored[name];
    return typeof found === 'boolean' ? found : PC_PREFS_DEFAULTS[name];
  };
  const pointer = parsePointer(stored['sensitivity'], stored['acceleration']);
  return {
    sensitivity: pointer.level,
    acceleration: pointer.acceleration,
    // Ligada só por escolha (o padrão é desligada): um valor guardado ligado, de antes deste campo, também foi escolhido.
    accelerationChosen: stored['accelerationChosen'] === true || pointer.acceleration,
    scrollSensitivity: parseScroll(stored['scrollSensitivity']),
    invertScroll: flag('invertScroll'),
    doubleTapDrag: flag('doubleTapDrag'),
    middleClick: flag('middleClick'),
    pinchZoom: flag('pinchZoom'),
    threeFingerGestures: flag('threeFingerGestures'),
    haptics: flag('haptics'),
    clickButtons: flag('clickButtons'),
    keepAwake: flag('keepAwake'),
    showTyped: flag('showTyped'),
    showTypedChecked: true,
    hintSeen: flag('hintSeen'),
    videoHintSeen: flag('videoHintSeen'),
  };
}

/** Migra o nível antigo sem perder uma escolha explícita de aceleração. */
function parsePointer(
  level: unknown,
  acceleration: unknown,
): { level: SensitivityLevel; acceleration: boolean } {
  const legacy =
    typeof level === 'string' && Object.hasOwn(LEGACY_POINTER_LEVEL, level)
      ? LEGACY_POINTER_LEVEL[level as LegacyPointerSensitivity]
      : undefined;

  return {
    level: isSensitivityLevel(level) ? level : (legacy?.level ?? PC_PREFS_DEFAULTS.sensitivity),
    acceleration:
      typeof acceleration === 'boolean'
        ? acceleration
        : (legacy?.acceleration ?? PC_PREFS_DEFAULTS.acceleration),
  };
}

function parseScroll(level: unknown): SensitivityLevel {
  if (isSensitivityLevel(level)) return level;
  if (typeof level === 'string' && Object.hasOwn(LEGACY_SCROLL_LEVEL, level)) {
    return LEGACY_SCROLL_LEVEL[level as LegacyScrollSensitivity];
  }
  return PC_PREFS_DEFAULTS.scrollSensitivity;
}

/** As escolhas que a pessoa faz de propósito (a dica já vista não conta como escolha). */
const CHOICES = [
  'sensitivity',
  'acceleration',
  'scrollSensitivity',
  'invertScroll',
  'doubleTapDrag',
  'middleClick',
  'pinchZoom',
  'threeFingerGestures',
  'haptics',
  'clickButtons',
  'keepAwake',
  'showTyped',
] as const satisfies readonly (keyof PcPrefsValue)[];

/**
 * Preferências do touchpad do PC. Valem só neste aparelho (a mesma pessoa pode querer outro ritmo no iPhone e no
 * tablet) e por conta, como a vibração do controle da TV. Nunca guarda dado sensível; sem armazenamento (modo privado) a
 * escolha vale até recarregar.
 */
@Injectable({ providedIn: 'root' })
export class PcPrefs {
  private readonly session = inject(SessionState);
  private readonly availability = inject(PcAvailability);
  private readonly storage = this.openStorage();
  private readonly value = linkedSignal<string | null, PcPrefsValue>({
    source: () => this.session.accountId(),
    computation: (accountId) => this.read(accountId),
  });

  readonly sensitivity = computed(() => this.value().sensitivity);
  readonly acceleration = computed(() => this.value().acceleration);
  readonly accelerationChosen = computed(() => this.value().accelerationChosen);
  /** Os ajustes do mouse do Windows do PC (só lidos), ou `null` sem eles. */
  readonly windowsMouse = computed(() => this.availability.status()?.mouse ?? null);
  /**
   * A aceleração que o ponteiro usa: a escolhida no app ou, sem escolha, a do Windows do PC (sem a leitura do Windows, a do
   * app, desligada por padrão). Vale já no primeiro gesto.
   */
  readonly pointerAcceleration = computed(() =>
    this.value().accelerationChosen
      ? this.value().acceleration
      : (this.windowsMouse()?.acceleration ?? this.value().acceleration),
  );
  readonly scrollSensitivity = computed(() => this.value().scrollSensitivity);
  readonly invertScroll = computed(() => this.value().invertScroll);
  readonly doubleTapDrag = computed(() => this.value().doubleTapDrag);
  readonly middleClick = computed(() => this.value().middleClick);
  readonly pinchZoom = computed(() => this.value().pinchZoom);
  readonly threeFingerGestures = computed(() => this.value().threeFingerGestures);
  readonly haptics = computed(() => this.value().haptics);
  readonly clickButtons = computed(() => this.value().clickButtons);
  readonly keepAwake = computed(() => this.value().keepAwake);
  readonly showTyped = computed(() => this.value().showTyped);
  readonly hintSeen = computed(() => this.value().hintSeen);
  readonly videoHintSeen = computed(() => this.value().videoHintSeen);
  /** Alguma escolha difere do padrão. */
  readonly customized = computed(() =>
    CHOICES.some((name) => this.value()[name] !== PC_PREFS_DEFAULTS[name]),
  );

  constructor() {
    // A vibração é um interruptor do módulo (os toques chamam `tick()` de todo lado): o ajuste o liga e desliga.
    effect(() => setHapticsEnabled(this.haptics()));
  }

  set(patch: Partial<PcPrefsValue>): void {
    const chosen = 'acceleration' in patch && !('accelerationChosen' in patch);
    const next = parsePrefs({
      ...this.value(),
      ...patch,
      ...(chosen ? { accelerationChosen: true } : {}),
    });
    this.value.set(next);
    this.write(next);
  }

  /** Volta as escolhas ao padrão; as dicas vistas continuam vistas. */
  reset(): void {
    this.set({
      ...PC_PREFS_DEFAULTS,
      hintSeen: this.value().hintSeen,
      videoHintSeen: this.value().videoHintSeen,
    });
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(accountId: string | null): PcPrefsValue {
    if (!accountId) return PC_PREFS_DEFAULTS;
    try {
      const raw = this.storage?.getItem(pcPrefsStorageKey(accountId));
      if (!raw) return PC_PREFS_DEFAULTS;
      const stored: unknown = JSON.parse(raw);
      const value = parsePrefs(stored);
      // Guardado antes da volta ao padrão: o eco volta a aparecer, uma vez, e a marca fica guardada.
      if (stored && typeof stored === 'object' && !('showTypedChecked' in stored)) {
        const migrated = { ...value, showTyped: true };
        this.write(migrated, accountId);
        return migrated;
      }
      return value;
    } catch {
      return PC_PREFS_DEFAULTS; // JSON corrompido: volta ao padrão sem quebrar o touchpad
    }
  }

  private write(value: PcPrefsValue, accountId = this.session.accountId()): void {
    if (!accountId) return;
    try {
      this.storage?.setItem(pcPrefsStorageKey(accountId), JSON.stringify(value));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }
}
