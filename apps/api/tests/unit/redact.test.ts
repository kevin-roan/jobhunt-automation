import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@deedy/shared';
import {
  Redactor,
  clearRedactionSource,
  installRedactionSource,
  type RedactionSource,
} from '../../src/core/redact.js';
import { AppLogger, maskContext, type PersistedLog } from '../../src/core/logger.js';

/** A frozen settings object, so the identity-keyed rule cache behaves as in prod. */
function sourceFor(profile: Partial<Settings['profile']> = {}): RedactionSource {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    profile: { ...DEFAULT_SETTINGS.profile, ...profile },
  };
  return { get: () => settings };
}

const CANDIDATE = {
  fullName: 'Jonathan Fairweather',
  firstName: 'Jonathan',
  lastName: 'Fairweather',
  email: 'jonathan.fairweather@example.com',
  phone: '+44 7700 900123',
  city: 'Manchester',
  postalCode: 'M15 4FN',
  linkedinUrl: 'https://www.linkedin.com/in/jfairweather',
  githubUrl: 'https://github.com/jfairweather',
} as const;

afterEach(() => {
  clearRedactionSource();
});

describe('Redactor, profile values', () => {
  const redactor = new Redactor(sourceFor(CANDIDATE));

  // The rendered `tailor_resume` prompt is the worst case: it carries the whole
  // profile block and the resume itself.
  const renderedPrompt = [
    'Candidate: Jonathan Fairweather',
    'Email: jonathan.fairweather@example.com',
    'Phone: +44 7700 900123',
    'Location: Manchester, M15 4FN',
    'LinkedIn: https://www.linkedin.com/in/jfairweather',
    'GitHub: https://github.com/jfairweather',
    '',
    '\\section{Experience} Fairweather led the payments rewrite at Globex.',
  ].join('\n');

  const scrubbed = redactor.text(renderedPrompt);

  it.each([
    ['full name', CANDIDATE.fullName],
    ['first name', CANDIDATE.firstName],
    ['last name', CANDIDATE.lastName],
    ['email', CANDIDATE.email],
    ['phone', CANDIDATE.phone],
    ['city', CANDIDATE.city],
    ['postal code', CANDIDATE.postalCode],
    ['linkedin url', CANDIDATE.linkedinUrl],
    ['github url', CANDIDATE.githubUrl],
  ])('removes the %s from a rendered prompt', (_label, value) => {
    expect(scrubbed).not.toContain(value);
  });

  it('labels what it removed instead of truncating silently', () => {
    expect(scrubbed).toContain('[REDACTED:name]');
    expect(scrubbed).toContain('[REDACTED:email]');
    expect(scrubbed).toContain('[REDACTED:city]');
  });

  it('leaves the surrounding structure readable for debugging', () => {
    expect(scrubbed).toContain('Email: ');
    expect(scrubbed).toContain('\\section{Experience}');
    expect(scrubbed).toContain('payments rewrite at Globex');
  });

  it('replaces the full name as one unit rather than piecemeal', () => {
    expect(redactor.text('Candidate: Jonathan Fairweather')).toBe(
      'Candidate: [REDACTED:name]',
    );
  });

  it('catches a name that appears in different casing', () => {
    expect(redactor.text('user JONATHAN FAIRWEATHER signed in')).toBe(
      'user [REDACTED:name] signed in',
    );
  });

  it('redacts the stored api keys as well as the profile', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      llm: { ...DEFAULT_SETTINGS.llm, apiKey: 'sk-local-abcdef123456' },
    };
    const withSecret = new Redactor({ get: () => settings });
    expect(withSecret.text('auth failed for sk-local-abcdef123456')).toBe(
      'auth failed for [REDACTED:secret]',
    );
  });

  it('passes nulls through untouched', () => {
    expect(redactor.nullable(null)).toBeNull();
  });
});

describe('Redactor, generic patterns', () => {
  // No profile at all: only the patterns can fire.
  const redactor = new Redactor(sourceFor());

  it('redacts an email the host was never told about', () => {
    expect(redactor.text('mailto recruiter: talent@globex.co.uk failed')).toBe(
      'mailto recruiter: [REDACTED:email] failed',
    );
  });

  it('redacts phone numbers in several notations', () => {
    for (const phone of ['+1 (555) 123-4567', '07700 900123', '212-555-0143']) {
      expect(redactor.text(`call ${phone} now`)).toBe('call [REDACTED:phone] now');
    }
  });

  it('does not shred an ISO timestamp', () => {
    const line = 'collected_at=2026-08-06T09:15:00.123Z';
    expect(redactor.text(line)).toBe(line);
  });

  it('does not shred durations, ports, versions or row ids', () => {
    for (const line of ['durationMs=300000', 'listening on 11434', 'v1.2.3', 'job 4821 scored']) {
      expect(redactor.text(line)).toBe(line);
    }
  });
});

describe('Redactor, empty profile', () => {
  it('never compiles an empty value into a match-everything pattern', () => {
    // Every profile string is '' by default - the bug this guards against would
    // turn each character of the input into a token.
    const redactor = new Redactor(sourceFor());
    expect(redactor.text('queue drained, 0 jobs pending')).toBe('queue drained, 0 jobs pending');
  });

  it('ignores values too short to be told apart from ordinary words', () => {
    const redactor = new Redactor(sourceFor({ firstName: 'Jo', city: 'Ely' }));
    expect(redactor.text('Jo works in Ely')).toBe('Jo works in Ely');
  });

  it('is inert with no source installed at all', () => {
    const redactor = new Redactor(null);
    expect(redactor.text('nothing configured yet')).toBe('nothing configured yet');
  });
});

describe('LlmService, real values still reach the model', () => {
  it('redacts the stored copy of a prompt but not the conversation sent out', async () => {
    // Assembled the way LlmService does: the same array object is handed to the
    // client and read again for the `llm_calls` row.
    const conversation = [
      { role: 'system' as const, content: 'You tailor resumes.' },
      { role: 'user' as const, content: `Email: ${CANDIDATE.email}` },
    ];
    const redactor = new Redactor(sourceFor(CANDIDATE));

    const sent: string[] = [];
    const complete = async (messages: typeof conversation): Promise<string> => {
      for (const message of messages) sent.push(message.content);
      return `Tailored for ${CANDIDATE.fullName}`;
    };
    const response = await complete(conversation);

    const stored = {
      systemPrompt: redactor.text(conversation[0]?.content ?? ''),
      userPrompt: redactor.text(conversation[conversation.length - 1]?.content ?? ''),
      response: redactor.text(response),
    };

    expect(sent).toContain(`Email: ${CANDIDATE.email}`);
    expect(stored.userPrompt).toBe('Email: [REDACTED:email]');
    expect(stored.response).toBe('Tailored for [REDACTED:name]');
    // The conversation itself must not have been mutated on the way past.
    expect(conversation[1]?.content).toBe(`Email: ${CANDIDATE.email}`);
  });
});

describe('AppLogger', () => {
  it('scrubs the message and the context before persisting them', () => {
    installRedactionSource(sourceFor(CANDIDATE));
    const persisted: PersistedLog[] = [];
    const logger = new AppLogger({
      level: 'info',
      onLog: (entry) => persisted.push(entry),
    });

    logger.warn(`application rejected for ${CANDIDATE.email}`, {
      // A PII value under a key the name-based masker does not recognise.
      assignee: CANDIDATE.fullName,
      apiKey: 'sk-should-be-masked-by-key-name',
      jobId: 4821,
    });

    const entry = persisted[0];
    expect(entry).toBeDefined();
    expect(entry?.message).toBe('application rejected for [REDACTED:email]');
    const context = entry?.context as Record<string, unknown>;
    expect(context.assignee).toBe('[REDACTED:name]');
    expect(context.apiKey).toBe('[REDACTED]');
    // Structure survives: the operational fields are still there to debug with.
    expect(context.jobId).toBe(4821);
  });

  it('leaves ordinary lines alone once the source is cleared', () => {
    const persisted: PersistedLog[] = [];
    const logger = new AppLogger({ level: 'info', onLog: (entry) => persisted.push(entry) });
    logger.info('collector run finished', { collected: 12 });
    expect(persisted[0]?.message).toBe('collector run finished');
  });
});

describe('maskContext', () => {
  it('redacts strings nested in arrays and objects', () => {
    installRedactionSource(sourceFor(CANDIDATE));
    const masked = maskContext({ answers: [{ value: CANDIDATE.email }] }) as {
      answers: { value: string }[];
    };
    expect(masked.answers[0]?.value).toBe('[REDACTED:email]');
  });

  it('redacts an error message', () => {
    installRedactionSource(sourceFor(CANDIDATE));
    const masked = maskContext(new Error(`could not fill ${CANDIDATE.email}`)) as {
      message: string;
    };
    expect(masked.message).toBe('could not fill [REDACTED:email]');
  });

});
