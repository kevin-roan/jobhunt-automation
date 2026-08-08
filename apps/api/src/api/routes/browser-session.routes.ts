import { browserSessionControlSchema, browserSessionStatusSchema } from '@deedy/shared';
import type { Container } from '../../core/container.js';
import { commonErrors, type ApiInstance } from '../types.js';

export async function browserSessionRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { browserSession } = container.services;

  app.get(
    '/browser/session',
    {
      schema: {
        tags: ['browser'],
        summary: 'State of the shared attended browser window',
        description:
          'Reports whether attended mode is on, whether this host can actually show a window, whether the window is open and what it has loaded, plus every source that needs a login and whether it currently has one. The sign-in state is the last stored probe result, not a fresh one — call the control endpoint with "check" to refresh it — so polling this never touches LinkedIn or Indeed.',
        response: { 200: browserSessionStatusSchema, ...commonErrors },
      },
    },
    async () => browserSession.status(),
  );

  app.post(
    '/browser/session/control',
    {
      schema: {
        tags: ['browser'],
        summary: 'Open, close, sign in to, or re-check the attended browser',
        description:
          '"open" and "close" control the one shared window; "check" re-probes a provider (or every provider needing a login) by loading a signed-in-only page. "signin" opens a browser window on this host\'s screen, on the provider\'s login page, for you to log in by hand — credentials are never entered, seen or stored by this application, and only the resulting session in the on-disk browser profile is reused. The new state is returned, so the caller never has to re-read /browser/session.',
        body: browserSessionControlSchema,
        response: { 200: browserSessionStatusSchema, ...commonErrors },
      },
    },
    async (request) => browserSession.control(request.body),
  );
}
