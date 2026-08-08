import { z } from 'zod';
import {
  providerCredentialDtoSchema,
  resolveSessionStrategy,
  saveCredentialSchema,
} from '@deedy/shared';
import { NotFoundError } from '../../core/errors.js';
import { nowIso } from '../../core/utils.js';
import type { Container } from '../../core/container.js';
import { commonErrors, okSchema, type ApiInstance } from '../types.js';

interface ProbeTarget {
  url: string;
  signedOut: RegExp;
}

/**
 * Sites we know how to interrogate. The probe URL is a page that only renders
 * for a signed-in session, so a redirect into the signed-out pattern is proof
 * the pasted session has lapsed.
 */
const PROBES: Record<string, ProbeTarget> = {
  linkedin: { url: 'https://www.linkedin.com/feed/', signedOut: /login|authwall/ },
  indeed: { url: 'https://www.indeed.com/', signedOut: /account\/login|challenge/ },
};

const verifyResponseSchema = z.object({
  provider: z.string(),
  /**
   * Whether the vault session is usable. Under the `attended` strategy there is
   * no vault session to judge, so this reads false with a `strategy` of
   * `attended` and a message naming the endpoint that CAN answer - a caller
   * must not read that as "the session is broken".
   */
  valid: z.boolean(),
  /** Which session a run would actually use, so the caller can read `valid` correctly. */
  strategy: z.enum(['attended', 'stored']),
  checkedAt: z.string(),
  message: z.string().nullable(),
});

export async function credentialsRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { credentials, notifications, settings } = container.services;

  app.get(
    '/credentials',
    {
      schema: {
        tags: ['browser'],
        summary: 'List stored provider sessions',
        description:
          'Metadata only. The encrypted cookie or token value never leaves the database.',
        response: {
          200: z.object({ credentials: z.array(providerCredentialDtoSchema) }),
          ...commonErrors,
        },
      },
    },
    async () => ({ credentials: credentials.list() }),
  );

  app.post(
    '/credentials',
    {
      schema: {
        tags: ['browser'],
        summary: 'Save a pasted provider session',
        description:
          'Accepts a Cookie header, a cookie extension JSON export, a Playwright storageState or a bare token. The value is encrypted at rest and applied to the live browser context immediately.',
        body: saveCredentialSchema,
        response: {
          201: providerCredentialDtoSchema.extend({ cookiesApplied: z.number().int() }),
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const saved = credentials.save(request.body);

      // Injection needs a live browser; a launch failure must not lose the
      // credential the user just pasted, so it only costs the immediate apply.
      let cookiesApplied = 0;
      try {
        cookiesApplied = await container.browser.applyCredentialsToContext(saved.provider);
      } catch (error) {
        container.logger.warn('could not apply credential to a live context', {
          provider: saved.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return reply.status(201).send({ ...saved, cookiesApplied });
    },
  );

  app.delete(
    '/credentials/:provider',
    {
      schema: {
        tags: ['browser'],
        summary: 'Delete a stored provider session',
        description:
          'Removes the pasted session from the vault. 404 when there is nothing stored for the provider, whatever the session strategy is: deleting a row that does not exist is not something to report as success, and an attended profile is not deleted from here - close or re-sign the window from the Browser page.',
        params: z.object({ provider: z.string().min(1) }),
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      const provider = request.params.provider.trim().toLowerCase();
      if (!credentials.get(provider)) throw new NotFoundError('Credential', provider);
      credentials.delete(provider);
      return { ok: true as const };
    },
  );

  app.post(
    '/credentials/:provider/verify',
    {
      schema: {
        tags: ['browser'],
        summary: 'Probe a provider to confirm the stored session still works',
        description:
          'Opens a signed-in-only page in the provider profile and reports whether the pasted session survived. Raises a notification when it has lapsed. This endpoint judges the credential vault only: when the effective session strategy is "attended" the vault is not what a run uses, so a provider with nothing pasted answers 200 with strategy "attended" and points at POST /browser/session/control with action "check", which probes the attended profile instead. A 404 therefore means the vault row is genuinely missing under the "stored" strategy.',
        params: z.object({ provider: z.string().min(1) }),
        response: { 200: verifyResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const provider = request.params.provider.trim().toLowerCase();
      const strategy = resolveSessionStrategy(settings.get().browser);
      const stored = credentials.get(provider);

      // Under the attended strategy the browser profile IS the session, so
      // "no vault row" is the normal, healthy state - a 404 here would tell a
      // signed-in user their credential is missing and send them off to paste a
      // cookie that nothing would ever read. Name the endpoint that can answer
      // the question they actually asked instead.
      if (!stored && strategy === 'attended') {
        return {
          provider,
          valid: false,
          strategy,
          checkedAt: nowIso(),
          message: `Session strategy is "attended", so ${provider} has no vault session to verify - the signed-in browser profile is the session. Check it with POST /browser/session/control {"action":"check","provider":"${provider}"}, or from the Browser page.`,
        };
      }
      if (!stored) throw new NotFoundError('Credential', provider);

      const probe = PROBES[provider];
      if (!probe) {
        return {
          provider,
          valid: false,
          strategy,
          checkedAt: nowIso(),
          message: `No verification probe is defined for "${provider}". Open the browser profile from Operations and check the session by hand.`,
        };
      }

      const valid = await container.browser.isAuthenticated(provider, probe.url, probe.signedOut);
      if (!valid) await notifications.credentialExpired(provider);

      return {
        provider,
        valid,
        strategy,
        checkedAt: nowIso(),
        message: valid ? null : 'The probe page redirected to a signed-out view.',
      };
    },
  );
}
