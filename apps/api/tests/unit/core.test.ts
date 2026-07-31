import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  maskSecret,
  sha256,
} from '../../src/core/crypto.js';
import {
  canonicalUrl,
  clamp,
  dayKey,
  isoPlusMs,
  jobHash,
  normalizeCompany,
  normalizeText,
  percent,
  safeJsonParse,
  slugify,
  stripHtml,
  truncate,
  uniqueBy,
} from '../../src/core/utils.js';

describe('normalizeText', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(normalizeText('  Senior   Backend\tEngineer \n')).toBe('senior backend engineer');
  });

  it('keeps characters that carry meaning in job titles', () => {
    expect(normalizeText('C++ / C# Developer (Node.js)')).toBe('c++ c# developer node.js');
  });

  it('replaces smart quotes and other punctuation with spaces', () => {
    expect(normalizeText('O’Reilly “Media”, Inc')).toBe('o reilly media inc');
  });

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeText('!!! ???')).toBe('');
  });
});

describe('normalizeCompany', () => {
  it('strips common legal suffixes', () => {
    expect(normalizeCompany('Acme Inc')).toBe('acme');
    expect(normalizeCompany('Acme LLC')).toBe('acme');
    expect(normalizeCompany('Acme Limited')).toBe('acme');
    expect(normalizeCompany('Acme GmbH')).toBe('acme');
  });

  it('treats suffixed and bare names as the same company', () => {
    expect(normalizeCompany('Globex Corporation')).toBe(normalizeCompany('Globex'));
  });

  it('does not strip suffixes that are only substrings', () => {
    expect(normalizeCompany('Incentro')).toBe('incentro');
    expect(normalizeCompany('Cohere')).toBe('cohere');
  });
});

describe('canonicalUrl', () => {
  it('drops tracking parameters but keeps meaningful ones', () => {
    expect(
      canonicalUrl('https://boards.example.com/jobs?id=42&utm_source=news&utm_campaign=x&gh_src=abc'),
    ).toBe('https://boards.example.com/jobs?id=42');
  });

  it('drops board-specific tracking parameters', () => {
    expect(
      canonicalUrl('https://example.com/view?trk=a&refId=b&trackingId=c&position=1&pageNum=0'),
    ).toBe('https://example.com/view');
  });

  it('removes the fragment', () => {
    expect(canonicalUrl('https://example.com/jobs/1#apply')).toBe('https://example.com/jobs/1');
  });

  it('strips the www prefix and lowercases the host', () => {
    expect(canonicalUrl('https://WWW.Example.COM/jobs/1')).toBe('https://example.com/jobs/1');
  });

  it('strips a trailing slash but keeps the root path', () => {
    expect(canonicalUrl('https://example.com/jobs/1/')).toBe('https://example.com/jobs/1');
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('maps tracked and untracked variants of one posting to a single URL', () => {
    const a = canonicalUrl('https://www.example.com/jobs/1/?utm_medium=email#top');
    const b = canonicalUrl('https://example.com/jobs/1');
    expect(a).toBe(b);
  });

  it('falls back to the trimmed input when the URL is unparseable', () => {
    expect(canonicalUrl('  not a url  ')).toBe('not a url');
  });
});

describe('jobHash', () => {
  const base = { source: 'greenhouse', company: 'Acme Inc', title: 'Backend Engineer', location: 'Remote' };

  it('returns a 64 character hex digest', () => {
    expect(jobHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls', () => {
    expect(jobHash(base)).toBe(jobHash({ ...base }));
  });

  it('ignores casing, spacing and legal suffixes', () => {
    expect(
      jobHash({
        source: 'GreenHouse',
        company: 'ACME  LLC',
        title: '  Backend   Engineer ',
        location: 'REMOTE',
      }),
    ).toBe(jobHash(base));
  });

  it('treats a missing location the same as an empty one', () => {
    expect(jobHash({ ...base, location: null })).toBe(jobHash({ ...base, location: '' }));
    expect(jobHash({ source: base.source, company: base.company, title: base.title })).toBe(
      jobHash({ ...base, location: '' }),
    );
  });

  it('is sensitive to every identity field', () => {
    const original = jobHash(base);
    expect(jobHash({ ...base, source: 'lever' })).not.toBe(original);
    expect(jobHash({ ...base, company: 'Globex' })).not.toBe(original);
    expect(jobHash({ ...base, title: 'Frontend Engineer' })).not.toBe(original);
    expect(jobHash({ ...base, location: 'Berlin' })).not.toBe(original);
  });

  it('does not collide when fields shift across the separator', () => {
    expect(jobHash({ source: 'ab', company: 'c', title: 'd', location: 'e' })).not.toBe(
      jobHash({ source: 'a', company: 'bc', title: 'd', location: 'e' }),
    );
  });
});

describe('stripHtml', () => {
  it('removes script and style blocks entirely', () => {
    expect(stripHtml('<style>p{color:red}</style><script>alert(1)</script><p>Hello</p>')).toBe(
      'Hello',
    );
  });

  it('turns block level tags into newlines', () => {
    expect(stripHtml('<p>One</p><p>Two</p>')).toBe('One\n Two');
    expect(stripHtml('First<br>Second<br/>Third')).toBe('First\nSecond\nThird');
  });

  it('renders list items as dashes', () => {
    expect(stripHtml('<ul><li>Alpha</li><li class="x">Beta</li></ul>')).toBe('- Alpha\n- Beta');
  });

  it('decodes the common named entities', () => {
    expect(stripHtml('R&amp;D &lt;tag&gt; &quot;quoted&quot;&nbsp;text')).toBe(
      'R&D <tag> "quoted" text',
    );
  });

  it('decodes numeric entities', () => {
    expect(stripHtml('&#65;&#66;&#67;')).toBe('ABC');
  });

  it('collapses runs of blank lines and trims', () => {
    expect(stripHtml('  A\n\n\n\n\nB  ')).toBe('A\n\nB');
  });

  it('returns plain text unchanged', () => {
    expect(stripHtml('just text')).toBe('just text');
  });
});

describe('truncate', () => {
  it('leaves short values untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('appends an ellipsis and respects the max length', () => {
    const result = truncate('hello world', 5);
    expect(result).toBe('hell…');
    expect(result).toHaveLength(5);
  });
});

describe('uniqueBy', () => {
  it('keeps the first occurrence of each key', () => {
    const items = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'a', n: 3 },
    ];
    expect(uniqueBy(items, (item) => item.id)).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(uniqueBy<string>([], (item) => item)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const items = ['a', 'a', 'b'];
    uniqueBy(items, (item) => item);
    expect(items).toEqual(['a', 'a', 'b']);
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it('falls back on invalid JSON', () => {
    const fallback = { a: 0 };
    expect(safeJsonParse('{not json', fallback)).toBe(fallback);
  });

  it('falls back on null, undefined and empty strings', () => {
    expect(safeJsonParse<string[]>(null, [])).toEqual([]);
    expect(safeJsonParse<string[]>(undefined, [])).toEqual([]);
    expect(safeJsonParse<string[]>('', [])).toEqual([]);
  });
});

describe('slugify', () => {
  it('produces a filesystem-safe slug', () => {
    expect(slugify('Senior Software Engineer @ Acme!')).toBe('senior-software-engineer-acme');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('--Hello--World--')).toBe('hello-world');
  });

  it('falls back to "item" when nothing survives', () => {
    expect(slugify('!!!')).toBe('item');
    expect(slugify('')).toBe('item');
  });

  it('honours the max length', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60);
    expect(slugify('abcdefghij', 4)).toBe('abcd');
  });
});

describe('clamp', () => {
  it('clamps to the bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('returns the bounds themselves unchanged', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('percent', () => {
  it('rounds to one decimal place', () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
  });

  it('handles the trivial ratios', () => {
    expect(percent(0, 10)).toBe(0);
    expect(percent(10, 10)).toBe(100);
  });

  it('returns 0 for a non-positive total', () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(5, -1)).toBe(0);
  });
});

describe('dayKey', () => {
  it('extracts the calendar day from an ISO timestamp', () => {
    expect(dayKey('2026-07-31T23:59:59.999Z')).toBe('2026-07-31');
  });

  it('is stable for two timestamps on the same UTC day', () => {
    expect(dayKey('2026-01-02T00:00:00.000Z')).toBe(dayKey('2026-01-02T18:30:00.000Z'));
  });
});

describe('isoPlusMs', () => {
  const fixedNow = new Date('2026-07-31T12:00:00.000Z');

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('adds the offset to the current time', () => {
    expect(isoPlusMs(60_000)).toBe('2026-07-31T12:01:00.000Z');
  });

  it('returns the current time for a zero offset', () => {
    expect(isoPlusMs(0)).toBe('2026-07-31T12:00:00.000Z');
  });

  it('accepts negative offsets', () => {
    expect(isoPlusMs(-3_600_000)).toBe('2026-07-31T11:00:00.000Z');
  });

  it('produces a value whose dayKey matches the shifted day', () => {
    expect(dayKey(isoPlusMs(24 * 60 * 60 * 1000))).toBe('2026-08-01');
  });
});

describe('encryptSecret / decryptSecret', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips a secret with a 32 byte key', () => {
    const secret = 'super-secret-token-1234';
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('round-trips multi-byte unicode payloads', () => {
    const unicode = 'pässwörd 密码 🔐';
    expect(decryptSecret(encryptSecret(unicode, key), key)).toBe(unicode);
  });

  it('produces a versioned, self-describing envelope', () => {
    const payload = encryptSecret('value', key);
    expect(payload.startsWith('enc:v1:')).toBe(true);
    expect(payload.slice('enc:v1:'.length).split(':')).toHaveLength(3);
  });

  it('uses a fresh IV so the same plaintext yields different ciphertexts', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('never leaks the plaintext into the envelope', () => {
    expect(encryptSecret('needle-in-haystack', key)).not.toContain('needle-in-haystack');
  });

  it('throws when decrypting with the wrong key', () => {
    const payload = encryptSecret('super-secret-token-1234', key);
    const wrongKey = Buffer.alloc(32, 9);
    expect(() => decryptSecret(payload, wrongKey)).toThrow();
  });

  it('throws when the ciphertext has been tampered with', () => {
    const payload = encryptSecret('super-secret-token-1234', key);
    const parts = payload.slice('enc:v1:'.length).split(':');
    const data = Buffer.from(parts[2] ?? '', 'base64');
    data[0] = (data[0] ?? 0) ^ 0xff;
    const tampered = `enc:v1:${parts[0] ?? ''}:${parts[1] ?? ''}:${data.toString('base64')}`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('throws on a malformed envelope', () => {
    expect(() => decryptSecret('enc:v1:onlyonepart', key)).toThrow(/Malformed encrypted payload/);
  });

  it('passes plaintext through untouched', () => {
    expect(decryptSecret('plain-value', key)).toBe('plain-value');
  });

  it('works with a randomly generated 32 byte key', () => {
    const randomKey = randomBytes(32);
    expect(decryptSecret(encryptSecret('rotate-me', randomKey), randomKey)).toBe('rotate-me');
  });
});

describe('isEncrypted', () => {
  it('recognises the encrypted prefix', () => {
    expect(isEncrypted(encryptSecret('x', Buffer.alloc(32, 1)))).toBe(true);
    expect(isEncrypted('enc:v1:a:b:c')).toBe(true);
  });

  it('rejects plaintext and other prefixes', () => {
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted('enc:v2:a:b:c')).toBe(false);
    expect(isEncrypted('prefix-enc:v1:a:b:c')).toBe(false);
  });
});

describe('maskSecret', () => {
  it('reveals only the last four characters', () => {
    expect(maskSecret('abcdefgh')).toBe('****efgh');
  });

  it('fully masks short values', () => {
    expect(maskSecret('abcd')).toBe('****');
    expect(maskSecret('a')).toBe('****');
  });

  it('returns an empty string for an empty value', () => {
    expect(maskSecret('')).toBe('');
  });

  it('caps the mask so long secrets do not leak their length', () => {
    const masked = maskSecret('x'.repeat(200));
    expect(masked).toBe(`${'*'.repeat(24)}xxxx`);
    expect(masked).toHaveLength(28);
  });
});

describe('sha256', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the known digest of "abc"', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and case sensitive', () => {
    expect(sha256('deedy')).toBe(sha256('deedy'));
    expect(sha256('deedy')).not.toBe(sha256('Deedy'));
  });

  it('always returns 64 hex characters', () => {
    expect(sha256('x'.repeat(10_000))).toMatch(/^[0-9a-f]{64}$/);
  });
});
