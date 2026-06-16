import { test, expect, describe } from 'bun:test';
import { sanitizeCssValue } from './cssValue';

describe('sanitizeCssValue', () => {
  test('identity for well-formed values (hash stability)', () => {
    for (const v of [
      'red',
      '0 0 56px 0 rgba(101, 41, 164, 0.38)',
      'url(data:image/png;base64,AAAA)', // `;` inside url() is part of the value
      "'IBM Plex Mono', monospace",
      '"a;b"', // `;` inside a string is part of the value
      'calc(100% - var(--site-margin) * 2)',
      'clamp(1rem, 2vw, 2rem)',
      '{{gap}}px', // template values pass through untouched
      '',
    ]) {
      expect(sanitizeCssValue(v)).toBe(v);
    }
  });

  test('truncates at the first top-level `;`/`{`/`}` (browser-style recovery)', () => {
    expect(
      sanitizeCssValue(
        '0 0 56px 0 rgba(101, 41, 164, 0.38);  Assets Videos  colorflow-animation (16) 1 140 x 140  Export',
      ),
    ).toBe('0 0 56px 0 rgba(101, 41, 164, 0.38)');
    expect(sanitizeCssValue('red; junk')).toBe('red');
    expect(sanitizeCssValue('red } junk')).toBe('red');
    expect(sanitizeCssValue('red { junk')).toBe('red');
    expect(sanitizeCssValue('{{x}}; junk')).toBe('{{x}}');
  });

  test('truncates at an unmatched `)`', () => {
    expect(sanitizeCssValue('rgb(0, 0, 0)) junk')).toBe('rgb(0, 0, 0)');
  });

  test('a value with nothing valid left sanitizes to ""', () => {
    expect(sanitizeCssValue('; all junk')).toBe('');
    expect(sanitizeCssValue('url(foo')).toBe(''); // unclosed paren would swallow the sheet
    expect(sanitizeCssValue('"unclosed')).toBe('');
  });

  test('escaped quotes inside strings do not end the string', () => {
    expect(sanitizeCssValue('"a\\";b"')).toBe('"a\\";b"');
  });
});
