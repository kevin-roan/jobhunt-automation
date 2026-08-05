import { vpnControlSchema, vpnStatusDtoSchema } from '@deedy/shared';
import type { Container } from '../../core/container.js';
import { commonErrors, type ApiInstance } from '../types.js';

export async function vpnRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { vpn } = container.services;

  app.get(
    '/vpn',
    {
      schema: {
        tags: ['vpn'],
        summary: 'Current exit location and the countries available',
        description:
          'Reports whether the configured backend is usable on this host, where the tunnel currently exits, and every country the backend can reach, so the dashboard can offer a picker instead of a free-text field. Job boards are regional — Indeed serves a different index per country — so the exit country decides which index a collector actually searches.',
        response: { 200: vpnStatusDtoSchema, ...commonErrors },
      },
    },
    async () => vpn.status(),
  );

  app.post(
    '/vpn/control',
    {
      schema: {
        tags: ['vpn'],
        summary: 'Connect, disconnect or rotate the VPN exit location',
        description:
          "Connecting changes the routing of the WHOLE HOST, not just this application — every other program on this machine starts exiting through the tunnel too, and disconnecting puts them all back. Read that before pressing the button. Changing exit country changes which regional job index is searched and spreads rate limiting across addresses; it is not a way around anti-bot fingerprinting, and rotating harder is not a substitute for crawling politely. Rotations are floored by minRotationSeconds unless 'force' is set. The new status is returned, so the caller never has to re-read /vpn.",
        body: vpnControlSchema,
        response: { 200: vpnStatusDtoSchema, ...commonErrors },
      },
    },
    async (request) => vpn.control(request.body),
  );
}
