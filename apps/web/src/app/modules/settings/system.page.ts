import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { isStepUpRequired, problemOf } from '../../core/auth/api-problem';
import { registerUnsavedWork } from '../../core/pwa/unsaved-work';
import { SessionState } from '../../core/session/session-state';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import { ModuleRegistry } from '../../core/modules/module-registry';
import { SystemApi, SystemSettingData, SystemSettingKey, SystemSettingValue } from './system-api';
import { SystemTvSection } from './system-tv-section';
import { SystemAgentErrorsSection } from './system-agent-errors-section';
import { SystemCapacitySection } from './system-capacity-section';
import { SystemHealthSection } from './system-health-section';

/**
 * Sistema (só do administrador): a configuração do app feita aqui, sem mexer em variáveis do servidor. Cada módulo que
 * tiver o que configurar traz a sua seção. A rota tem o guarda de papel e a seção só carrega para o administrador.
 */
@Component({
  selector: 'app-system-page',
  host: { 'data-screen-ready': 'settings-data' },
  imports: [
    LoadingSkeleton,
    SystemAgentErrorsSection,
    SystemCapacitySection,
    SystemHealthSection,
    SystemTvSection,
  ],
  templateUrl: './system.page.html',
  styleUrl: './system.page.css',
  styles: `
    :host {
      display: block;
      max-width: 40rem;
      margin-inline: auto;
    }
  `,
})
export class SystemPage {
  private readonly api = inject(SystemApi);
  private readonly session = inject(SessionState);
  private readonly registry = inject(ModuleRegistry);
  protected readonly settings = signal<readonly SystemSettingValue[] | null>(null);
  protected readonly contact = signal('');
  protected readonly limit = signal(2);
  protected readonly offlineMinutes = signal(10);
  protected readonly lightCleanup = signal(true);
  protected readonly deepCleanup = signal(true);
  protected readonly deepCleanupThreshold = signal(160);
  /** Os módulos ainda sem tela: o administrador escolhe quais aparecem como "Em Breve" na Início de todas as contas. */
  protected readonly soonModules = this.registry.modules.filter(
    (module) => module.status === 'soon',
  );
  protected readonly soonShown = signal<readonly string[]>([]);
  protected readonly busy = signal<SystemSettingKey | null>(null);
  protected readonly configLoading = signal(false);
  protected readonly configFailed = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);

  /** O e-mail de contato digitado ainda difere do que o servidor guardou (nada carregado ainda: limpo). */
  private readonly contactDirty = computed(() => {
    const saved = this.settings()?.find((item) => item.key === 'training.off-contact');
    return saved !== undefined && this.contact() !== String(saved.value ?? '');
  });

  constructor() {
    registerUnsavedWork(() => this.contactDirty());
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.settings()) === null
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    this.configFailed.set(false);
    this.configLoading.set(true);
    try {
      const values = await this.api.systemSettings();
      this.settings.set(values);
      this.contact.set(
        String(values.find((item) => item.key === 'training.off-contact')?.value ?? ''),
      );
      this.limit.set(
        Number(values.find((item) => item.key === 'devices.max-per-guest')?.value ?? 2),
      );
      this.offlineMinutes.set(
        Number(values.find((item) => item.key === 'devices.agent-offline-minutes')?.value ?? 10),
      );
      const soon = values.find((item) => item.key === 'home.soon-modules')?.value;
      this.soonShown.set(Array.isArray(soon) ? soon : []);
      this.lightCleanup.set(
        values.find((item) => item.key === 'tv.light-cleanup-enabled')?.value !== false,
      );
      this.deepCleanup.set(
        values.find((item) => item.key === 'tv.deep-cleanup-enabled')?.value !== false,
      );
      this.deepCleanupThreshold.set(
        Number(
          values.find((item) => item.key === 'tv.deep-cleanup-memory-threshold-mb')?.value ?? 160,
        ),
      );
    } catch {
      this.configFailed.set(true);
      this.error.set(
        $localize`:@@settings.system.config.load-error:Não foi possível carregar as configurações.`,
      );
      return;
    } finally {
      this.configLoading.set(false);
    }
  }

  protected setting(key: SystemSettingKey): SystemSettingValue | undefined {
    return this.settings()?.find((item) => item.key === key);
  }

  protected source(key: SystemSettingKey): string {
    return this.setting(key)?.source === 'app'
      ? $localize`:@@settings.system.config.source-app:do app`
      : $localize`:@@settings.system.config.source-server:do serviço`;
  }

  protected async save(key: SystemSettingKey, value: SystemSettingData): Promise<void> {
    await this.saveGroup([[key, value]]);
  }

  /** Um salvar para o grupo, mas só os valores que mudaram: não pede confirmação nem grava o que ficou igual. */
  protected saveDeviceSettings(): Promise<void> {
    const current = new Map(this.settings()?.map((item) => [item.key, item.value]));
    return this.saveGroup(
      (
        [
          ['devices.max-per-guest', this.limit()],
          ['devices.agent-offline-minutes', this.offlineMinutes()],
        ] as const
      ).filter(([key, value]) => current.get(key) !== value),
    ).then(() => undefined);
  }

  /**
   * Interruptor: salva ao alternar, sem botão. Se o servidor recusar (ou houver outro salvamento em curso), o
   * interruptor volta ao valor anterior, para a tela nunca mostrar ligado o que o servidor não aceitou.
   */
  protected async toggle(
    key: SystemSettingKey,
    flag: WritableSignal<boolean>,
    input: HTMLInputElement,
  ): Promise<void> {
    const previous = flag();
    flag.set(input.checked);
    if (!(await this.saveGroup([[key, input.checked]]))) {
      flag.set(previous);
      input.checked = previous;
    }
  }

  /** Interruptor de um módulo "em breve": liga ou desliga na Início de todas as contas, salvando ao alternar. */
  protected async toggleSoon(id: string, input: HTMLInputElement): Promise<void> {
    const previous = this.soonShown();
    const next = input.checked ? [...previous, id] : previous.filter((shown) => shown !== id);
    this.soonShown.set(next);
    if (!(await this.saveGroup([['home.soon-modules', next]]))) {
      this.soonShown.set(previous);
      input.checked = !input.checked;
    }
  }

  /** Devolve se o servidor aceitou todos os valores do grupo. */
  private async saveGroup(
    values: readonly (readonly [SystemSettingKey, SystemSettingData])[],
  ): Promise<boolean> {
    if (this.busy()) return false;
    if (values.length === 0) return true;
    this.busy.set(values[0][0]);
    this.error.set(null);
    this.saved.set(false);
    let applied = 0;
    try {
      // Um de cada vez: cada gravação pode pedir a confirmação com a passkey, e dois pedidos juntos abririam dois diálogos.
      for (const [key, value] of values) {
        const updated = await this.api.saveSystemSetting(key, value);
        this.settings.update(
          (items) => items?.map((item) => (item.key === key ? updated : item)) ?? [updated],
        );
        applied += 1;
      }
      this.saved.set(true);
      return true;
    } catch (error) {
      const problem = problemOf(error);
      this.error.set(
        applied > 0
          ? $localize`:@@settings.system.config.partial:Uma parte foi salva e outra não. Os valores da tela seguem como você os deixou: confira e salve de novo.`
          : problem && isStepUpRequired(problem)
            ? $localize`:@@settings.system.config.unconfirmed:A mudança não foi confirmada com a passkey.`
            : problem?.status === 400
              ? $localize`:@@settings.system.config.invalid:Confira o valor e tente de novo.`
              : $localize`:@@settings.system.config.save-error:Não foi possível salvar agora.`,
      );
    } finally {
      this.busy.set(null);
    }
    return false;
  }

  protected async resetCleanupDefaults(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('tv.light-cleanup-enabled');
    this.error.set(null);
    this.saved.set(false);
    try {
      const values = await Promise.all([
        this.api.resetSystemSetting('tv.light-cleanup-enabled'),
        this.api.resetSystemSetting('tv.deep-cleanup-enabled'),
        this.api.resetSystemSetting('tv.deep-cleanup-memory-threshold-mb'),
      ]);
      this.settings.update(
        (items) =>
          items?.map((item) => values.find((value) => value.key === item.key) ?? item) ?? values,
      );
      this.lightCleanup.set(values[0].value === true);
      this.deepCleanup.set(values[1].value === true);
      this.deepCleanupThreshold.set(Number(values[2].value));
      this.saved.set(true);
    } catch {
      this.error.set(
        $localize`:@@settings.system.config.reset-error:Não foi possível voltar à configuração padrão agora.`,
      );
    } finally {
      this.busy.set(null);
    }
  }
}
