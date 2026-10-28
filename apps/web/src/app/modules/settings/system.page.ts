import { Component, effect, inject, signal, untracked } from '@angular/core';
import { isStepUpRequired, problemOf } from '../../core/auth/api-problem';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, SystemSettingKey, SystemSettingValue } from './system-api';
import { SystemTvSection } from './system-tv-section';
import { SystemHealthSection } from './system-health-section';

/**
 * Sistema (só do administrador): a configuração do app feita aqui, sem mexer em variáveis do servidor. Cada módulo que
 * tiver o que configurar traz a sua seção. A rota tem o guarda de papel e a seção só carrega para o administrador.
 */
@Component({
  selector: 'app-system-page',
  imports: [SystemHealthSection, SystemTvSection],
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
  protected readonly settings = signal<readonly SystemSettingValue[] | null>(null);
  protected readonly contact = signal('');
  protected readonly limit = signal(2);
  protected readonly offlineMinutes = signal(10);
  protected readonly photos = signal(false);
  /** Se o bucket do servidor está completo; `null` enquanto não se sabe (ou se a leitura falhou). */
  protected readonly bucketConfigured = signal<boolean | null>(null);
  protected readonly lightCleanup = signal(true);
  protected readonly deepCleanup = signal(true);
  protected readonly deepCleanupThreshold = signal(160);
  protected readonly busy = signal<SystemSettingKey | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);

  constructor() {
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
      this.photos.set(
        values.find((item) => item.key === 'training.photo-storage-enabled')?.value === true,
      );
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
      this.error.set(
        $localize`:@@settings.system.config.load-error:Não foi possível carregar as configurações.`,
      );
      return;
    }
    // Só informativo: se a leitura falhar, a tela segue sem a linha de estado (o servidor ainda recusa ligar sem bucket).
    try {
      this.bucketConfigured.set((await this.api.photoBucket()).configured === true);
    } catch {
      this.bucketConfigured.set(null);
    }
  }

  protected bucketStatus(): string | null {
    const configured = this.bucketConfigured();
    if (configured === null) return null;
    return configured
      ? $localize`:@@settings.system.config.bucket-ready:Bucket pronto no servidor.`
      : $localize`:@@settings.system.config.bucket-not-ready:Bucket ainda não configurado no servidor. Configure-o antes de ligar as fotos.`;
  }

  protected setting(key: SystemSettingKey): SystemSettingValue | undefined {
    return this.settings()?.find((item) => item.key === key);
  }

  protected source(key: SystemSettingKey): string {
    return this.setting(key)?.source === 'app'
      ? $localize`:@@settings.system.config.source-app:do app`
      : $localize`:@@settings.system.config.source-server:do servidor`;
  }

  protected async save(key: SystemSettingKey, value: string | number | boolean): Promise<void> {
    if (this.busy()) return;
    this.busy.set(key);
    this.error.set(null);
    this.saved.set(false);
    try {
      const updated = await this.api.saveSystemSetting(key, value);
      this.settings.update(
        (items) => items?.map((item) => (item.key === key ? updated : item)) ?? [updated],
      );
      this.saved.set(true);
    } catch (error) {
      const problem = problemOf(error);
      this.error.set(
        problem && isStepUpRequired(problem)
          ? $localize`:@@settings.system.config.unconfirmed:A mudança não foi confirmada com a passkey.`
          : problem?.kind === 'photo-bucket-not-configured'
            ? $localize`:@@settings.system.config.bucket-missing:Configure o bucket no servidor antes de ligar as fotos.`
            : problem?.status === 400
              ? $localize`:@@settings.system.config.invalid:Confira o valor e tente de novo.`
              : $localize`:@@settings.system.config.save-error:Não foi possível salvar agora.`,
      );
    } finally {
      this.busy.set(null);
    }
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
