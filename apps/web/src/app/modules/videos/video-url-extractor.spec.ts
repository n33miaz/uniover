import { describe, expect, it } from 'vitest';
import { extractVideoUrl } from './video-url-extractor';
import { MAX_SHARE_PARAM_LENGTH } from './share-input-limits';

describe('extractVideoUrl', () => {
  it('extracts direct URL when present in payload.url', () => {
    const url = extractVideoUrl({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      text: 'Title of video',
      title: 'Title',
    });
    expect(url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('extracts URL from text when url is empty or null (Android share behavior)', () => {
    const url = extractVideoUrl({
      url: '',
      text: 'Olha que video legal https://www.instagram.com/reel/C3abc123/ compartilhado',
      title: 'Instagram',
    });
    expect(url).toBe('https://www.instagram.com/reel/C3abc123/');
  });

  it('extracts URL from title when url and text are empty', () => {
    const url = extractVideoUrl({
      url: null,
      text: null,
      title: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(url).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('extracts URL from title when title contains descriptive text and URL', () => {
    const url = extractVideoUrl({
      title: 'Destaque: https://x.com/uniover/status/1234567890',
    });
    expect(url).toBe('https://x.com/uniover/status/1234567890');
  });

  it('handles typical Android YouTube app share format with newlines', () => {
    const url = extractVideoUrl({
      text: 'Never Gonna Give You Up\nhttps://youtu.be/dQw4w9WgXcQ',
    });
    expect(url).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it.each(['\t', '\r', '\n'])('rejects credentials split by %j in the url field', (separator) => {
    expect(extractVideoUrl({ url: `https://user${separator}:senha@example.org/video` })).toBeNull();
  });

  it.each(['@perfil', 'nota: contato@example.org'])(
    'extracts a link followed by %s on a separate line',
    (description) => {
      expect(extractVideoUrl({ text: `https://example.org\n${description}` })).toBe(
        'https://example.org/',
      );
    },
  );

  it('handles typical Android TikTok app share format', () => {
    const url = extractVideoUrl({
      text: 'Confira este video incrivel! https://vm.tiktok.com/ZM8abc123/',
    });
    expect(url).toBe('https://vm.tiktok.com/ZM8abc123/');
  });

  it('strips trailing punctuation like periods, commas, exclamation marks, or closing brackets', () => {
    expect(extractVideoUrl({ text: 'Link: https://youtube.com/watch?v=123.' })).toBe(
      'https://youtube.com/watch?v=123',
    );

    expect(extractVideoUrl({ text: 'Link: https://youtube.com/watch?v=123!' })).toBe(
      'https://youtube.com/watch?v=123',
    );

    expect(extractVideoUrl({ text: 'Link: (https://youtube.com/watch?v=123).' })).toBe(
      'https://youtube.com/watch?v=123',
    );

    expect(extractVideoUrl({ text: 'Veja em [https://instagram.com/p/123] agora' })).toBe(
      'https://instagram.com/p/123',
    );
  });

  it('strips punctuation exposed by closing parentheses and keeps balanced path parentheses', () => {
    expect(extractVideoUrl({ text: '(https://youtu.be/dQw4w9WgXcQ.)' })).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
    expect(extractVideoUrl({ text: '(https://example.org/a_(b).)' })).toBe(
      'https://example.org/a_(b)',
    );
  });

  it('detects and adds https protocol to domain-prefixed URLs without protocol', () => {
    expect(extractVideoUrl({ text: 'Acesse www.youtube.com/watch?v=123' })).toBe(
      'https://www.youtube.com/watch?v=123',
    );

    expect(extractVideoUrl({ text: 'No instagram.com/reel/12345' })).toBe(
      'https://instagram.com/reel/12345',
    );
  });

  it('skips ordinary words and malformed candidates before a valid URL', () => {
    expect(extractVideoUrl({ url: 'Vídeo', text: 'Destaque', title: 'HTTPS://youtu.be/abc' })).toBe(
      'https://youtu.be/abc',
    );
    expect(extractVideoUrl({ text: 'https://bad:port/ veja https://example.org/a_(b)' })).toBe(
      'https://example.org/a_(b)',
    );
    expect(extractVideoUrl({ text: 'https://youtu.be/abc veja agora' })).toBe(
      'https://youtu.be/abc',
    );
    expect(extractVideoUrl({ title: 'Instagram' })).toBeNull();
  });

  it('returns null when no URL is present in any field', () => {
    expect(extractVideoUrl({ text: 'Apenas uma mensagem sem link nenhum' })).toBeNull();
    expect(extractVideoUrl({ title: 'Apenas titulo', text: 'Apenas texto' })).toBeNull();
    expect(extractVideoUrl({})).toBeNull();
    expect(extractVideoUrl(null)).toBeNull();
    expect(extractVideoUrl(undefined)).toBeNull();
  });

  it('truncates text longer than MAX_SHARE_PARAM_LENGTH and extracts URL within range', () => {
    const prefix = 'https://youtu.be/dQw4w9WgXcQ ';
    const oversized = prefix + 'x'.repeat(MAX_SHARE_PARAM_LENGTH * 2);
    const result = extractVideoUrl({ text: oversized });
    expect(result).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('does not extract URL placed beyond the truncation boundary', () => {
    const padding = 'a'.repeat(MAX_SHARE_PARAM_LENGTH);
    const tail = ' https://youtu.be/abc';
    const result = extractVideoUrl({ text: padding + tail });
    expect(result).toBeNull();
  });

  it('handles all fields oversized without throwing', () => {
    const big = 'x'.repeat(MAX_SHARE_PARAM_LENGTH + 1000);
    expect(() => extractVideoUrl({ url: big, text: big, title: big })).not.toThrow();
    expect(extractVideoUrl({ url: big, text: big, title: big })).toBeNull();
  });

  it('does not hang on pathological regex input within the limit', () => {
    // Repetitive near-match pattern that could cause backtracking on the LINK regex.
    const evil = 'https://youtu.be/' + 'a/'.repeat(MAX_SHARE_PARAM_LENGTH / 2);
    const start = performance.now();
    extractVideoUrl({ text: evil.slice(0, MAX_SHARE_PARAM_LENGTH) });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  describe('unsafe protocol rejection', () => {
    it('returns null for javascript: scheme in url field', () => {
      expect(extractVideoUrl({ url: 'javascript:alert(1)' })).toBeNull();
    });

    it('returns null for javascript: scheme in text field', () => {
      expect(extractVideoUrl({ text: 'click here javascript:alert(1)' })).toBeNull();
    });

    it('returns null for data: scheme', () => {
      expect(extractVideoUrl({ url: 'data:text/html,<script>alert(1)</script>' })).toBeNull();
    });

    it('returns null for blob: scheme', () => {
      expect(extractVideoUrl({ url: 'blob:https://example.com/uuid-1234' })).toBeNull();
    });

    it('returns null for file: scheme', () => {
      expect(extractVideoUrl({ url: 'file:///etc/passwd' })).toBeNull();
    });

    it('returns null for vbscript: scheme', () => {
      expect(extractVideoUrl({ url: 'vbscript:MsgBox(1)' })).toBeNull();
    });

    it('skips links wrapped by another scheme and keeps the next safe link', () => {
      expect(
        extractVideoUrl({
          text: 'view-source:https://evil.example/x e o vídeo https://youtu.be/abc',
        }),
      ).toBe('https://youtu.be/abc');
    });

    it('still extracts a link right after a pt-BR label with colon', () => {
      expect(extractVideoUrl({ text: 'Veja:https://youtu.be/abc' })).toBe('https://youtu.be/abc');
    });
  });
});
