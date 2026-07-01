import { test, expect, describe } from 'bun:test';
import { buildSocialMetaTags } from './metaTags';

describe('buildSocialMetaTags', () => {
  test('emits og + twitter from explicit fields (card = summary_large_image when ogImage)', () => {
    const out = buildSocialMetaTags({
      title: 'Page Title',
      description: 'Page description',
      ogTitle: 'OG Title',
      ogDescription: 'OG Description',
      ogImage: 'https://example.com/image.jpg',
      ogType: 'article',
    });
    expect(out).toContain('<meta property="og:title" content="OG Title" />');
    expect(out).toContain('<meta property="og:description" content="OG Description" />');
    expect(out).toContain('<meta property="og:image" content="https://example.com/image.jpg" />');
    expect(out).toContain('<meta property="og:type" content="article" />');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(out).toContain('<meta name="twitter:title" content="OG Title" />');
    expect(out).toContain('<meta name="twitter:description" content="OG Description" />');
  });

  test('does NOT emit title/description/canonical (BaseLayout owns those)', () => {
    const out = buildSocialMetaTags({ title: 'T', description: 'D', url: 'https://x.com/p' });
    expect(out).not.toContain('<title>');
    expect(out).not.toContain('name="description"');
    expect(out).not.toContain('rel="canonical"');
    // og:url IS emitted from url, canonical is not.
    expect(out).toContain('<meta property="og:url" content="https://x.com/p" />');
  });

  test('ogTitle/ogDescription fall back to title/description', () => {
    const out = buildSocialMetaTags({ title: 'Plain Title', description: 'Plain Description' });
    expect(out).toContain('<meta property="og:title" content="Plain Title" />');
    expect(out).toContain('<meta property="og:description" content="Plain Description" />');
    expect(out).toContain('<meta name="twitter:title" content="Plain Title" />');
  });

  test('ogType defaults to website when OG content present', () => {
    const out = buildSocialMetaTags({ title: 'T' });
    expect(out).toContain('<meta property="og:type" content="website" />');
  });

  test('twitter:card = summary when no ogImage', () => {
    const out = buildSocialMetaTags({ title: 'T', description: 'D' });
    expect(out).toContain('<meta name="twitter:card" content="summary" />');
    expect(out).not.toContain('summary_large_image');
  });

  test('no twitter:image is emitted (inherits og:image)', () => {
    const out = buildSocialMetaTags({ title: 'T', ogImage: '/images/x.png' });
    expect(out).not.toContain('twitter:image');
  });

  test('empty input emits nothing', () => {
    expect(buildSocialMetaTags({})).toBe('');
  });

  test('keywords emitted from native field', () => {
    const out = buildSocialMetaTags({ keywords: 'a, b, c' });
    expect(out).toContain('<meta name="keywords" content="a, b, c" />');
  });

  test('og:image absolutized against siteUrl for root-relative paths', () => {
    const out = buildSocialMetaTags({ ogImage: '/images/photo.png', siteUrl: 'https://example.com' });
    expect(out).toContain('<meta property="og:image" content="https://example.com/images/photo.png" />');
  });

  test('og:image absolutize strips a trailing slash on siteUrl', () => {
    const out = buildSocialMetaTags({ ogImage: '/images/photo.png', siteUrl: 'https://example.com/' });
    expect(out).toContain('content="https://example.com/images/photo.png"');
  });

  test('og:image does NOT swap webp/avif → jpg (astro divergence from core)', () => {
    const out = buildSocialMetaTags({ ogImage: '/images/photo.webp', siteUrl: 'https://example.com' });
    expect(out).toContain('content="https://example.com/images/photo.webp"');
    expect(out).not.toContain('.jpg');
  });

  test('external absolute og:image left untouched (not prefixed)', () => {
    const out = buildSocialMetaTags({ ogImage: 'https://cdn.example.com/x.webp', siteUrl: 'https://example.com' });
    expect(out).toContain('<meta property="og:image" content="https://cdn.example.com/x.webp" />');
  });

  test('twitter:site / twitter:creator from handle, @-normalized', () => {
    const out = buildSocialMetaTags({ title: 'T', twitterHandle: 'meno' });
    expect(out).toContain('<meta name="twitter:site" content="@meno" />');
    expect(out).toContain('<meta name="twitter:creator" content="@meno" />');
  });

  test('twitter handle already @-prefixed is not double-prefixed', () => {
    const out = buildSocialMetaTags({ title: 'T', twitterHandle: '@meno' });
    expect(out).toContain('content="@meno"');
    expect(out).not.toContain('@@meno');
  });

  test('HTML-escapes content values', () => {
    const out = buildSocialMetaTags({ ogTitle: 'Title & <stuff>' });
    expect(out).toContain('<meta property="og:title" content="Title &amp; &lt;stuff&gt;" />');
    expect(out).toContain('<meta name="twitter:title" content="Title &amp; &lt;stuff&gt;" />');
  });

  test('non-string inputs coerce to empty (defensive)', () => {
    const out = buildSocialMetaTags({ title: undefined, ogTitle: { _i18n: true } as unknown, ogImage: 123 as unknown });
    // No crash; the i18n object / number do not leak into output as [object Object]/123.
    expect(out).not.toContain('[object Object]');
    expect(out).not.toContain('content="123"');
  });

  describe('customCode dedup (backward-compat)', () => {
    test('suppresses og + twitter entirely when customCode already declares an og: tag', () => {
      const out = buildSocialMetaTags({
        title: 'T',
        ogTitle: 'OG',
        ogImage: '/images/x.png',
        customCodeHead: '<meta content="OG" property="og:title">',
      });
      expect(out).not.toContain('property="og:');
      expect(out).not.toContain('name="twitter:');
    });

    test('suppresses og + twitter when customCode declares a twitter: tag (single-quoted)', () => {
      const out = buildSocialMetaTags({
        title: 'T',
        customCodeHead: "<meta name='twitter:card' content='summary'>",
      });
      expect(out).not.toContain('property="og:');
      expect(out).not.toContain('name="twitter:');
    });

    test('keywords still emitted even when customCode owns the social surface', () => {
      const out = buildSocialMetaTags({
        keywords: 'a, b',
        ogTitle: 'OG',
        customCodeHead: '<meta content="OG" property="og:title">',
      });
      expect(out).toContain('<meta name="keywords" content="a, b" />');
      expect(out).not.toContain('property="og:');
    });

    test('keywords suppressed when customCode already declares a keywords meta', () => {
      const out = buildSocialMetaTags({
        keywords: 'a, b',
        customCodeHead: '<meta name="keywords" content="x, y">',
      });
      expect(out).not.toContain('name="keywords"');
    });

    test('native social emitted when customCode has unrelated tags only', () => {
      const out = buildSocialMetaTags({
        ogTitle: 'OG',
        customCodeHead: '<script defer src="https://plausible.io/js/script.js"></script>',
      });
      expect(out).toContain('<meta property="og:title" content="OG" />');
    });
  });
});
