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

export function platformLabel(platform: VideoPlatform): string {
  switch (platform) {
    case 'instagram':
      return 'Instagram';
    case 'youtube':
      return 'YouTube';
    case 'tiktok':
      return 'TikTok';
    case 'twitter':
      return 'X (Twitter)';
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
