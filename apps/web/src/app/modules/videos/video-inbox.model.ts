import { modulePermission } from '../../core/auth/guest-home';
import type { AccountRole } from '../../core/session/session-state';

export type VideoPlatform = 'instagram' | 'youtube' | 'tiktok' | 'twitter' | 'other';

export interface VideoInboxItem {
  readonly id: string;
  readonly canonical_url: string;
  readonly platform: VideoPlatform;
  readonly captured_at: string;
  readonly raw_text: string;
  readonly captured_via: 'share_target' | 'manual';
  readonly status: 'link_only';
  readonly title?: string | null;
}

export interface RawSharePayload {
  readonly url?: string | null;
  readonly text?: string | null;
  readonly title?: string | null;
  readonly timestamp?: number;
}

export function canAccessVideoInbox(
  role: AccountRole | null,
  permissions: readonly string[] | null,
): boolean {
  return role === 'owner' || !!permissions?.includes(modulePermission('videos'));
}

export function platformLabel(platform: VideoPlatform): string {
  switch (platform) {
    case 'instagram':
      return $localize`:@@videos.platform.instagram:Instagram`;
    case 'youtube':
      return $localize`:@@videos.platform.youtube:YouTube`;
    case 'tiktok':
      return $localize`:@@videos.platform.tiktok:TikTok`;
    case 'twitter':
      return $localize`:@@videos.platform.twitter:X (Twitter)`;
    case 'other':
      return $localize`:@@videos.platform.other:Outros`;
  }
}

export function statusLabel(status: VideoInboxItem['status']): string {
  switch (status) {
    case 'link_only':
      return $localize`:@@videos.inbox.status.link-only:Apenas link`;
  }
}

export function viaLabel(via: VideoInboxItem['captured_via']): string {
  switch (via) {
    case 'manual':
      return $localize`:@@videos.inbox.via.manual:Adicionado à mão`;
    case 'share_target':
      return $localize`:@@videos.inbox.via.share-target:Compartilhamento`;
  }
}
