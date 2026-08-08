import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type LlmSettings } from '@deedy/shared';
import {
  assertLocalLlmEndpoint,
  createLlmClient,
  isLocalEndpointHost,
} from '../../src/services/llm/providers.js';
import { ConfigurationError } from '../../src/core/errors.js';

function settings(baseUrl: string, allowRemoteEndpoint = false): LlmSettings {
  return { ...DEFAULT_SETTINGS.llm, baseUrl, allowRemoteEndpoint };
}

/** Every prompt this app builds contains the candidate's full resume and PII. */
describe('LLM endpoint guard', () => {
  describe('accepts endpoints on this machine or its private network', () => {
    const accepted = [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      // The whole 127/8 block is loopback, not just .0.0.1.
      'http://127.1.2.3:8080',
      'http://[::1]:11434',
      // IPv4-mapped loopback. `URL` normalises this to `::ffff:7f00:1`, so both
      // spellings have to be understood.
      'http://[::ffff:127.0.0.1]:11434',
      'http://[::ffff:7f00:1]:11434',
      'http://[::ffff:192.168.1.5]:11434',
      'http://10.0.0.5:11434',
      'http://172.16.4.2:11434',
      'http://172.31.255.254:11434',
      'http://192.168.1.50:11434',
      'http://169.254.10.1:11434',
      'http://[fe80::1]:11434',
      'http://[fd00::1]:11434',
      'http://workstation.local:11434',
      // This project's own compose service name — a bare, dotless hostname.
      'http://ollama:11434',
      // What the install docs tell users to point at a host-side Ollama.
      'http://host.docker.internal:11434',
      'https://localhost/v1',
    ];

    for (const baseUrl of accepted) {
      it(`allows ${baseUrl}`, () => {
        expect(() => assertLocalLlmEndpoint(settings(baseUrl))).not.toThrow();
      });
    }
  });

  describe('refuses endpoints that are demonstrably off this host', () => {
    const refused = [
      'https://api.openai.com/v1',
      'https://openrouter.ai/api/v1',
      'https://generativelanguage.googleapis.com',
      'http://8.8.8.8:11434',
      // 172.32 is outside RFC1918's 172.16/12 — an easy off-by-one to get wrong.
      'http://172.32.0.1:11434',
      'http://11.0.0.1:11434',
      'http://192.169.1.1:11434',
      'http://[2606:4700::1111]:11434',
      // A public v4 address does not become local by being written as v6.
      'http://[::ffff:8.8.8.8]:11434',
      // A public host does not become local by being spelled with a trailing dot.
      'https://api.openai.com./v1',
    ];

    for (const baseUrl of refused) {
      it(`refuses ${baseUrl}`, () => {
        expect(() => assertLocalLlmEndpoint(settings(baseUrl))).toThrow(ConfigurationError);
      });
    }
  });

  it('names the offending host and the setting that overrides the refusal', () => {
    let caught: unknown;
    try {
      assertLocalLlmEndpoint(settings('https://api.openai.com/v1'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    const message = (caught as ConfigurationError).message;
    expect(message).toContain('api.openai.com');
    expect(message).toContain('Allow remote LLM endpoint');
  });

  it('never leaks credentials embedded in the base URL into the error', () => {
    let message = '';
    try {
      assertLocalLlmEndpoint(settings('https://user:hunter2@api.openai.com/v1'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('api.openai.com');
    expect(message).not.toContain('hunter2');
  });

  it('allows a public host once the flag is deliberately turned on', () => {
    expect(() =>
      assertLocalLlmEndpoint(settings('https://api.openai.com/v1', true)),
    ).not.toThrow();
  });

  // The flag is an escape hatch for the host check only — it must not be a
  // general "skip validation" switch.
  it('still rejects a malformed base URL when the flag is off', () => {
    expect(() => assertLocalLlmEndpoint(settings('not-a-url'))).toThrow(ConfigurationError);
  });

  it('defaults to refusing remote endpoints', () => {
    expect(DEFAULT_SETTINGS.llm.allowRemoteEndpoint).toBe(false);
  });

  // The guard is worthless if a caller can construct a client around it.
  it('is enforced by createLlmClient, the single construction point', () => {
    expect(() => createLlmClient(settings('https://api.openai.com/v1'))).toThrow(
      ConfigurationError,
    );
    expect(() => createLlmClient(settings('http://ollama:11434'))).not.toThrow();
  });

  it('is applied before the provider is validated, so a bad host cannot slip through', () => {
    const bad = { ...settings('https://api.openai.com/v1'), provider: 'nonsense' } as LlmSettings;
    expect(() => createLlmClient(bad)).toThrow(ConfigurationError);
  });

  describe('isLocalEndpointHost', () => {
    it('treats a bare service name as local but a dotted public name as remote', () => {
      expect(isLocalEndpointHost('ollama')).toBe(true);
      expect(isLocalEndpointHost('llm-server')).toBe(true);
      expect(isLocalEndpointHost('api.openai.com')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isLocalEndpointHost('LOCALHOST')).toBe(true);
      expect(isLocalEndpointHost('Workstation.Local')).toBe(true);
    });

    it('rejects an empty host', () => {
      expect(isLocalEndpointHost('')).toBe(false);
      expect(isLocalEndpointHost('   ')).toBe(false);
    });

    // Four dotted octets that are out of range are not an address at all, so
    // they fall through to the name rules — and a dotted name is not local.
    it('does not mistake an out-of-range dotted quad for a private address', () => {
      expect(isLocalEndpointHost('999.1.1.1')).toBe(false);
    });
  });
});

describe('exit IP verification', () => {
  // A third party's hostname must not be baked into the schema of a product
  // that promises nothing leaves the host.
  it('ships no default endpoint', () => {
    expect(DEFAULT_SETTINGS.vpn.exitIpEndpoint).toBe('');
    expect(DEFAULT_SETTINGS.vpn.verifyExitIp).toBe(false);
  });
});

describe('profile answers that must not be guessed', () => {
  // 0 is a real answer to "years of experience" and the form filler would type
  // it into a live application; null means "not set" and escalates instead.
  it('defaults to null rather than zero', () => {
    expect(DEFAULT_SETTINGS.profile.yearsOfExperience).toBeNull();
    expect(DEFAULT_SETTINGS.profile.noticePeriodDays).toBeNull();
  });
});
