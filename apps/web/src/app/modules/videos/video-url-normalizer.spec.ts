import { describe, expect, it } from 'vitest';
import { isHttpUrl, normalizeVideoUrl } from './video-url-normalizer';

describe('normalizeVideoUrl', () => {
  describe('Instagram', () => {
    it('normalizes reels to canonical /reel/ID/ format and strips tracking parameters', () => {
      const result = normalizeVideoUrl(
        'https://instagram.com/reel/C3abc123/?igsh=xyz123&utm_source=ig_web_copy_link',
      );
      expect(result.platform).toBe('instagram');
      expect(result.canonical_url).toBe('https://www.instagram.com/reel/C3abc123/');
    });

    it('normalizes /reels/ path to /reel/ with trailing slash', () => {
      const result = normalizeVideoUrl('https://www.instagram.com/reels/C3abc123');
      expect(result.platform).toBe('instagram');
      expect(result.canonical_url).toBe('https://www.instagram.com/reel/C3abc123/');
    });

    it('preserves opaque Instagram share links', () => {
      const reelResult = normalizeVideoUrl('https://www.instagram.com/share/reel/C3abc123');
      expect(reelResult.platform).toBe('instagram');
      expect(reelResult.canonical_url).toBe('https://www.instagram.com/share/reel/C3abc123');

      const postResult = normalizeVideoUrl('https://www.instagram.com/share/p/C3abc123');
      expect(postResult.platform).toBe('instagram');
      expect(postResult.canonical_url).toBe('https://www.instagram.com/share/p/C3abc123');
    });

    it('normalizes instagr.am shortened hostname to www.instagram.com', () => {
      const result = normalizeVideoUrl('https://instagr.am/p/C3abc123');
      expect(result.platform).toBe('instagram');
      expect(result.canonical_url).toBe('https://www.instagram.com/p/C3abc123/');
    });
  });

  describe('YouTube', () => {
    it('converts shortened youtu.be link to canonical www.youtube.com/watch?v=ID', () => {
      const result = normalizeVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=abcdef123456');
      expect(result.platform).toBe('youtube');
      expect(result.canonical_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('preserves timestamp parameter when converting shortened youtu.be link', () => {
      const result = normalizeVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=120&si=abc');
      expect(result.platform).toBe('youtube');
      expect(result.canonical_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120');
    });

    it('normalizes YouTube Shorts URL and removes tracking params', () => {
      const result = normalizeVideoUrl(
        'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share&si=abc',
      );
      expect(result.platform).toBe('youtube');
      expect(result.canonical_url).toBe('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    });

    it('normalizes mobile m.youtube.com watch link', () => {
      const result = normalizeVideoUrl(
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=ygU%3D&feature=shared',
      );
      expect(result.platform).toBe('youtube');
      expect(result.canonical_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });
  });

  describe('TikTok', () => {
    it('normalizes desktop and mobile video URL and removes tracking params', () => {
      const result = normalizeVideoUrl(
        'https://www.tiktok.com/@creator/video/7123456789012345678?_t=8abcd&_r=1&sender_device=pc',
      );
      expect(result.platform).toBe('tiktok');
      expect(result.canonical_url).toBe(
        'https://www.tiktok.com/@creator/video/7123456789012345678',
      );
    });

    it('normalizes m.tiktok.com to www.tiktok.com', () => {
      const result = normalizeVideoUrl(
        'https://m.tiktok.com/@creator/video/7123456789012345678?is_from_webapp=1',
      );
      expect(result.platform).toBe('tiktok');
      expect(result.canonical_url).toBe(
        'https://www.tiktok.com/@creator/video/7123456789012345678',
      );
    });

    it('normalizes vm.tiktok.com and vt.tiktok.com shortened links', () => {
      const vmResult = normalizeVideoUrl('https://vm.tiktok.com/ZM8abc123/?utm_source=app');
      expect(vmResult.platform).toBe('tiktok');
      expect(vmResult.canonical_url).toBe('https://vm.tiktok.com/ZM8abc123/');

      const vtResult = normalizeVideoUrl('https://vt.tiktok.com/ZM8abc123/?_t=8');
      expect(vtResult.platform).toBe('tiktok');
      expect(vtResult.canonical_url).toBe('https://vt.tiktok.com/ZM8abc123/');
    });
  });

  describe('Twitter / X', () => {
    it('normalizes twitter.com to x.com and strips tracking parameters', () => {
      const result = normalizeVideoUrl(
        'https://twitter.com/uniover/status/1234567890?s=20&t=abcdef&ref_src=twsrc',
      );
      expect(result.platform).toBe('twitter');
      expect(result.canonical_url).toBe('https://x.com/uniover/status/1234567890');
    });

    it('normalizes x.com link directly', () => {
      const result = normalizeVideoUrl('https://x.com/uniover/status/1234567890?mx=2');
      expect(result.platform).toBe('twitter');
      expect(result.canonical_url).toBe('https://x.com/uniover/status/1234567890');
    });

    it('normalizes t.co shortened link to twitter platform', () => {
      const result = normalizeVideoUrl('https://t.co/abc123xyz');
      expect(result.canonical_url).toBe('https://t.co/abc123xyz');
      expect(result.platform).toBe('twitter');
    });
  });

  describe('Other platforms and fallback', () => {
    it('normalizes other video URLs and strips global utm tracking parameters', () => {
      const result = normalizeVideoUrl(
        'https://vimeo.com/123456789?utm_source=test&utm_campaign=share&foo=bar',
      );
      expect(result.platform).toBe('other');
      expect(result.canonical_url).toBe('https://vimeo.com/123456789?foo=bar');
    });

    it('gracefully handles malformed URLs without throwing', () => {
      const result = normalizeVideoUrl('not-a-valid-url:::');
      expect(result.platform).toBe('other');
      expect(result.canonical_url).toBe('not-a-valid-url:::');
    });
  });

  describe('immutability', () => {
    it.each([
      ['Instagram', 'https://www.instagram.com/reel/C3abc123/?igsh=xyz123'],
      ['YouTube', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=ygU%3D&feature=shared'],
      ['TikTok', 'https://m.tiktok.com/@creator/video/7123456789012345678?_t=8abcd&_r=1'],
      ['Twitter', 'https://twitter.com/uniover/status/1234567890?s=20&t=abcdef'],
      ['Other', 'https://vimeo.com/123456789?utm_source=test&foo=bar'],
    ])('does not mutate the original URL object for %s', (_platform, rawUrl) => {
      const original = new URL(rawUrl);
      const snapshotBefore = original.toString();
      const paramsBefore = Array.from(original.searchParams.entries());
      expect(normalizeVideoUrl(original)).toEqual(normalizeVideoUrl(rawUrl));
      expect(original.toString()).toBe(snapshotBefore);
      expect(Array.from(original.searchParams.entries())).toEqual(paramsBefore);
    });
  });

  describe('unsafe protocol handling', () => {
    it('returns platform other and preserves raw value for javascript: scheme', () => {
      const result = normalizeVideoUrl('javascript:alert(1)');
      expect(result.platform).toBe('other');
      expect(result.canonical_url).toBe('javascript:alert(1)');
    });

    it('returns platform other and preserves raw value for data: scheme', () => {
      const result = normalizeVideoUrl('data:text/html,<script>alert(1)</script>');
      expect(result.platform).toBe('other');
      expect(result.canonical_url).toBe('data:text/html,<script>alert(1)</script>');
    });

    it('returns platform other and preserves raw value for blob: scheme', () => {
      const result = normalizeVideoUrl('blob:https://example.com/some-uuid');
      expect(result.platform).toBe('other');
      expect(result.canonical_url).toBe('blob:https://example.com/some-uuid');
    });

    it('returns platform other and preserves raw value for file: scheme', () => {
      const result = normalizeVideoUrl('file:///etc/passwd');
      expect(result.platform).toBe('other');
      expect(result.canonical_url).toBe('file:///etc/passwd');
    });

    it('does not rewrite protocol to https when input is javascript:', () => {
      const result = normalizeVideoUrl('javascript:void(0)');
      expect(result.canonical_url).not.toContain('https:');
      expect(result.canonical_url).toBe('javascript:void(0)');
    });
  });

  it('keeps host:port input without scheme working', () => {
    expect(normalizeVideoUrl('example.com:8080/video').canonical_url).toBe(
      'https://example.com:8080/video',
    );
  });
});

describe('isHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isHttpUrl('https://youtu.be/abc')).toBe(true);
    expect(isHttpUrl('http://example.com/')).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/uuid',
    'file:///etc/passwd',
    'vbscript:MsgBox(1)',
    'youtu.be/abc',
    '',
  ])('rejects %s', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});
