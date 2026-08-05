import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  VpnBackend,
  VpnControlInput,
  VpnCountryDto,
  VpnSettings,
  VpnStatusDto,
} from '@deedy/shared';
import type { Logger } from '../../core/logger.js';
import { toErrorMessage } from '../../core/errors.js';
import { nowIso } from '../../core/utils.js';
import type { SettingsService } from '../settings.service.js';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));

const HELPER_SCRIPT = 'protonvpn_ctl.py';

/**
 * Every country lookup is a subprocess spawn (Proton) that takes a second or
 * two, and the dashboard polls status. The list changes on the order of weeks.
 */
const COUNTRY_CACHE_TTL_MS = 5 * 60 * 1000;

/** The exit-IP check is a nicety; it must never be the reason a connect is slow. */
const EXIT_IP_TIMEOUT_MS = 5_000;

/** Floor for any spawn, so a five-second connect timeout still leaves room to exec. */
const MIN_SPAWN_TIMEOUT_MS = 5_000;

const NO_BACKEND_REASON =
  'No VPN backend is selected. Choose one in Settings > VPN: "protonvpn" drives the ' +
  'installed Proton VPN Linux client, or use nmcli / wg_quick / command for a tunnel you ' +
  'already manage yourself.';

/** The JSON contract of assets/vpn/protonvpn_ctl.py. Anything else is a failure. */
interface HelperStatus {
  ok: boolean;
  available?: boolean;
  loggedIn?: boolean;
  connected?: boolean;
  country?: string | null;
  serverName?: string | null;
  reason?: string;
  error?: string;
}

interface HelperCountries {
  ok: boolean;
  countries?: Array<{ code: string; name: string; servers: number }>;
  available?: boolean;
  reason?: string;
  error?: string;
}

/** What a backend can tell us about the tunnel right now. */
interface BackendStatus {
  available: boolean;
  unavailableReason: string | null;
  connected: boolean;
  country: string | null;
  serverName: string | null;
}

const UNKNOWN_STATUS: BackendStatus = {
  available: true,
  unavailableReason: null,
  connected: false,
  country: null,
  serverName: null,
};

/**
 * Drives the host's VPN so the collectors can choose their exit country.
 *
 * Two honest reasons this exists. Job boards are regional — Indeed serves a
 * different index per country, so a German search from an Indian exit returns
 * the wrong result set — and a single IP crawling all day gets rate-limited, so
 * spreading a slow crawl across a few exits keeps each one under the limit.
 * Indeed is currently answering 403 "Request Blocked" to this host, and moving
 * the exit is a reasonable thing to try.
 *
 * It is NOT a way around anti-bot fingerprinting. A serious detection stack
 * scores TLS fingerprints, header order, timing and browser internals; the exit
 * IP is one weak signal, and commercial VPN ranges often score *worse* than the
 * residential address they replace. Rotating faster is not a substitute for
 * crawling politely, which is why `minRotationSeconds` is enforced here and why
 * nothing in this class retries a blocked request on its own.
 */
export class VpnService {
  /**
   * Serialises every operation. Two collectors rotating at once would race each
   * other's tunnel and leave the exit somewhere neither of them chose.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Rotation floor bookkeeping. In memory on purpose: a process restart resets
   * the clock, which at worst allows one extra rotation after a restart — not
   * worth a table, and a restart is already a manual event.
   */
  private lastRotatedAtMs: number | null = null;
  private lastRotatedAt: string | null = null;
  private rotationIndex = 0;

  private lastError: string | null = null;
  private exitIp: string | null = null;

  private countryCache: { at: number; backend: VpnBackend; countries: VpnCountryDto[] } | null =
    null;

  private cachedHelperPath: string | null = null;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
  ) {}

  /** Current tunnel state plus the country list, for the dashboard. */
  async status(): Promise<VpnStatusDto> {
    return this.serialise(async () => {
      const vpn = this.settings();
      const backendStatus = await this.readStatus(vpn);
      const countries = await this.readCountries(vpn);
      return this.toDto(vpn, backendStatus, countries);
    });
  }

  /** Connect / disconnect / advance to the next country in the rotation. */
  async control(input: VpnControlInput): Promise<VpnStatusDto> {
    return this.serialise(async () => {
      const vpn = this.settings();

      if (vpn.backend === 'none') {
        const countries = await this.readCountries(vpn);
        return this.toDto(
          vpn,
          { ...UNKNOWN_STATUS, available: false, unavailableReason: NO_BACKEND_REASON },
          countries,
        );
      }

      try {
        if (input.action === 'disconnect') {
          await this.disconnect(vpn);
          this.exitIp = null;
        } else {
          // `force` is what the dashboard button sets: a human pressing rotate
          // is not the runaway case minRotationSeconds exists to prevent.
          const country =
            input.action === 'rotate' ? this.nextCountry(vpn) : (input.country ?? null);
          if (input.action === 'rotate' && !input.force && !this.cooldownElapsed(vpn)) {
            this.lastError = `Rotation is rate-limited to one change every ${vpn.minRotationSeconds}s.`;
          } else {
            await this.connect(vpn, country);
            this.markRotated();
            this.lastError = null;
          }
        }
      } catch (error) {
        this.lastError = toErrorMessage(error);
        this.logger.warn('vpn control failed', { action: input.action, error: this.lastError });
      }

      const backendStatus = await this.readStatus(vpn);
      const countries = await this.readCountries(vpn);
      return this.toDto(vpn, backendStatus, countries);
    });
  }

  /**
   * Called by a collector that hit a block. Advances the exit if rotation is on
   * and the cooldown has elapsed. Returns whether the exit actually moved, so the
   * caller can decide whether retrying is worthwhile.
   */
  async rotateOnBlock(collectorId: string, reason: string): Promise<boolean> {
    const vpn = this.settings();
    if (!vpn.enabled || vpn.backend === 'none' || !vpn.rotateOnBlock) return false;
    if (!this.appliesTo(vpn, collectorId)) return false;
    if (!this.cooldownElapsed(vpn)) {
      // Deliberately quiet about it: a blocked crawl that keeps asking is the
      // exact situation the floor exists for, and logging it per request would
      // bury everything else.
      this.logger.debug('vpn rotation suppressed by cooldown', { collectorId });
      return false;
    }

    return this.serialise(async () => {
      // Re-checked inside the lock: another collector may have rotated while
      // this one was queued, in which case the exit has already moved.
      if (!this.cooldownElapsed(vpn)) return false;

      const country = this.nextCountry(vpn);
      this.logger.info('rotating vpn exit after a block', { collectorId, reason, country });
      try {
        await this.connect(vpn, country);
        this.markRotated();
        this.lastError = null;
        return true;
      } catch (error) {
        this.lastError = toErrorMessage(error);
        this.logger.warn('vpn rotation failed', { collectorId, error: this.lastError });
        return false;
      }
    });
  }

  /** Brings the tunnel up before a run when configured to. No-op otherwise. */
  async prepareForCollector(collectorId: string): Promise<void> {
    const vpn = this.settings();
    if (!vpn.enabled || vpn.backend === 'none' || !vpn.connectBeforeCollect) return;
    if (!this.appliesTo(vpn, collectorId)) return;

    await this.serialise(async () => {
      const current = await this.readStatus(vpn);
      if (current.connected) return;
      try {
        await this.connect(vpn, this.currentCountry(vpn));
        this.lastError = null;
      } catch (error) {
        // A collector run is more useful from the host's own IP than not at
        // all, so this reports and returns rather than aborting the run.
        this.lastError = toErrorMessage(error);
        this.logger.warn('could not bring the vpn up before a collector run', {
          collectorId,
          error: this.lastError,
        });
      }
    });
  }

  /** Drops it afterwards when configured to. */
  async releaseAfterCollector(collectorId: string): Promise<void> {
    const vpn = this.settings();
    if (!vpn.enabled || vpn.backend === 'none' || !vpn.disconnectAfterCollect) return;
    if (!this.appliesTo(vpn, collectorId)) return;

    await this.serialise(async () => {
      try {
        await this.disconnect(vpn);
        this.exitIp = null;
      } catch (error) {
        this.lastError = toErrorMessage(error);
        this.logger.warn('could not drop the vpn after a collector run', {
          collectorId,
          error: this.lastError,
        });
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Serialisation                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Chains onto a single in-flight promise. The `catch` on the tail keeps one
   * failed operation from poisoning every operation queued behind it.
   */
  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* Backend dispatch                                                       */
  /* ---------------------------------------------------------------------- */

  private settings(): VpnSettings {
    return this.settingsService.get().vpn;
  }

  private async readStatus(vpn: VpnSettings): Promise<BackendStatus> {
    if (vpn.backend === 'none') {
      return { ...UNKNOWN_STATUS, available: false, unavailableReason: NO_BACKEND_REASON };
    }
    try {
      switch (vpn.backend) {
        case 'protonvpn':
          return await this.protonStatus(vpn);
        case 'nmcli':
          return await this.nmcliStatus(vpn);
        case 'wg_quick':
          return await this.wgQuickStatus(vpn);
        case 'command':
          return await this.commandStatus(vpn);
      }
    } catch (error) {
      return {
        ...UNKNOWN_STATUS,
        available: false,
        unavailableReason: this.describeSpawnFailure(vpn.backend, error),
      };
    }
  }

  private async connect(vpn: VpnSettings, country: string | null): Promise<void> {
    switch (vpn.backend) {
      case 'protonvpn': {
        const args = ['connect', '--timeout', String(vpn.connectTimeoutSeconds)];
        if (country) args.push('--country', country.toUpperCase());
        const result = await this.runHelper<HelperStatus>(vpn, args);
        if (!result.ok) throw new Error(result.error ?? 'Proton VPN refused the connection.');
        break;
      }
      case 'nmcli':
        await this.spawn(vpn, 'nmcli', ['connection', 'up', 'id', this.nmcliName(vpn, country)]);
        break;
      case 'wg_quick':
        // wg-quick manipulates routes and interfaces, so on almost every host
        // this needs passwordless sudo for the invoking user. The failure is
        // surfaced verbatim in `unavailableReason` when it happens.
        await this.spawn(vpn, 'wg-quick', ['up', this.wgInterface(vpn, country)]);
        break;
      case 'command': {
        const argv = this.template(vpn.connectCommand, country);
        if (!argv) throw new Error('No connect command is configured for the "command" backend.');
        await this.spawn(vpn, argv[0] as string, argv.slice(1));
        break;
      }
      case 'none':
        return;
    }

    await this.verifyExitIp(vpn);
  }

  private async disconnect(vpn: VpnSettings): Promise<void> {
    switch (vpn.backend) {
      case 'protonvpn': {
        const result = await this.runHelper<HelperStatus>(vpn, ['disconnect']);
        if (!result.ok) throw new Error(result.error ?? 'Proton VPN refused to disconnect.');
        return;
      }
      case 'nmcli': {
        const current = await this.nmcliStatus(vpn);
        await this.spawn(vpn, 'nmcli', [
          'connection',
          'down',
          'id',
          this.nmcliName(vpn, current.country),
        ]);
        return;
      }
      case 'wg_quick': {
        const current = await this.wgQuickStatus(vpn);
        await this.spawn(vpn, 'wg-quick', ['down', this.wgInterface(vpn, current.country)]);
        return;
      }
      case 'command': {
        const argv = this.template(vpn.disconnectCommand, null);
        if (!argv) throw new Error('No disconnect command is configured for the "command" backend.');
        await this.spawn(vpn, argv[0] as string, argv.slice(1));
        return;
      }
      case 'none':
        return;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* protonvpn backend                                                      */
  /* ---------------------------------------------------------------------- */

  private async protonStatus(vpn: VpnSettings): Promise<BackendStatus> {
    const result = await this.runHelper<HelperStatus>(vpn, ['status']);
    if (result.available === false) {
      return {
        ...UNKNOWN_STATUS,
        available: false,
        unavailableReason: result.reason ?? 'Proton VPN is not usable on this host.',
      };
    }
    if (!result.ok) {
      return {
        ...UNKNOWN_STATUS,
        available: false,
        unavailableReason: result.error ?? 'The Proton VPN helper failed.',
      };
    }
    return {
      available: true,
      unavailableReason: null,
      connected: result.connected === true,
      country: result.country ?? null,
      serverName: result.serverName ?? null,
    };
  }

  private async protonCountries(vpn: VpnSettings): Promise<VpnCountryDto[]> {
    const result = await this.runHelper<HelperCountries>(vpn, ['countries']);
    return (result.countries ?? []).map((entry) => ({
      code: entry.code,
      name: entry.name,
      servers: entry.servers,
    }));
  }

  /** `python3 <helper> <args...>`, with the single JSON object parsed off stdout. */
  private async runHelper<T>(vpn: VpnSettings, args: string[]): Promise<T> {
    const script = this.helperPath();
    // `python3` from PATH rather than a pinned interpreter: the proton packages
    // are installed into the system Python by the distro package, and a venv
    // would not see them.
    const { stdout } = await this.spawn(vpn, 'python3', [script, ...args]);
    const line = stdout.trim().split('\n').pop() ?? '';
    try {
      return JSON.parse(line) as T;
    } catch {
      // stdout is never logged: it is the one place a future helper change
      // could leak something session-shaped.
      throw new Error('The Proton VPN helper did not return JSON on stdout.');
    }
  }

  /**
   * Absolute path to the bundled helper, resolved for both the src layout
   * (src/services/vpn -> ../../../assets) and the compiled dist layout
   * (dist/services/vpn -> ../../../assets), mirroring LatexService.assetsDir().
   */
  private helperPath(): string {
    if (this.cachedHelperPath) return this.cachedHelperPath;

    const candidates = [
      path.resolve(here, '../../../assets/vpn'),
      path.resolve(here, '../../../../assets/vpn'),
      path.resolve(process.cwd(), 'assets/vpn'),
      path.resolve(process.cwd(), 'apps/api/assets/vpn'),
    ];
    for (const dir of candidates) {
      const script = path.join(dir, HELPER_SCRIPT);
      if (existsSync(script)) {
        this.cachedHelperPath = script;
        return script;
      }
    }
    throw new Error(
      `Could not locate ${HELPER_SCRIPT}. Tried: ${candidates.join(', ')}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* nmcli backend                                                          */
  /* ---------------------------------------------------------------------- */

  private nmcliName(vpn: VpnSettings, country: string | null): string {
    return `${vpn.nmcliConnectionPrefix}${(country ?? '').toUpperCase()}`;
  }

  private async nmcliStatus(vpn: VpnSettings): Promise<BackendStatus> {
    const { stdout } = await this.spawn(vpn, 'nmcli', [
      '-t',
      '-f',
      'NAME,TYPE',
      'connection',
      'show',
      '--active',
    ]);
    const prefix = vpn.nmcliConnectionPrefix;
    for (const row of stdout.split('\n')) {
      // `-t` is colon-separated; a connection name may itself contain an
      // escaped colon, so the TYPE is taken from the tail, not from index 1.
      const parts = row.split(':');
      if (parts.length < 2) continue;
      const type = parts[parts.length - 1]?.trim() ?? '';
      const name = parts.slice(0, -1).join(':');
      if (type !== 'vpn' && type !== 'wireguard' && type !== 'tun') continue;
      if (prefix && !name.startsWith(prefix)) continue;
      return {
        available: true,
        unavailableReason: null,
        connected: true,
        country: prefix ? (name.slice(prefix.length).toUpperCase() || null) : null,
        serverName: name,
      };
    }
    return { ...UNKNOWN_STATUS };
  }

  /* ---------------------------------------------------------------------- */
  /* wg_quick backend                                                       */
  /* ---------------------------------------------------------------------- */

  private wgInterface(vpn: VpnSettings, country: string | null): string {
    // wg-quick names interfaces after the config file, and interface names are
    // conventionally lower case.
    return `${vpn.nmcliConnectionPrefix}${(country ?? '').toLowerCase()}`;
  }

  private async wgQuickStatus(vpn: VpnSettings): Promise<BackendStatus> {
    const { stdout } = await this.spawn(vpn, 'wg', ['show', 'interfaces']);
    const prefix = vpn.nmcliConnectionPrefix;
    const iface = stdout
      .trim()
      .split(/\s+/)
      .filter((name) => name.length > 0)
      .find((name) => !prefix || name.startsWith(prefix));
    if (!iface) return { ...UNKNOWN_STATUS };
    return {
      available: true,
      unavailableReason: null,
      connected: true,
      country: prefix ? (iface.slice(prefix.length).toUpperCase() || null) : null,
      serverName: iface,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* command backend                                                        */
  /* ---------------------------------------------------------------------- */

  private async commandStatus(vpn: VpnSettings): Promise<BackendStatus> {
    const argv = this.template(vpn.statusCommand, null);
    if (!argv) {
      // No status command is a legitimate configuration: the user's script may
      // be fire-and-forget. Reporting "available, state unknown" is more honest
      // than claiming disconnected.
      return { ...UNKNOWN_STATUS };
    }
    const { stdout } = await this.spawn(vpn, argv[0] as string, argv.slice(1));
    const text = stdout.trim();
    return {
      available: true,
      unavailableReason: null,
      connected: text.length > 0 && !/^(down|disconnected|inactive|off)$/i.test(text),
      country: null,
      serverName: null,
    };
  }

  /**
   * Splits a user template on whitespace into an argv array, substituting
   * `{{country}}`.
   *
   * The result is passed to execFile as separate arguments and never to a
   * shell, so a template can neither pipe, chain, redirect nor expand a
   * variable: `curl x | sh` becomes an attempt to exec a program called `curl`
   * with the literal arguments `x`, `|` and `sh`. Settings are writable from
   * the dashboard, so this is the boundary that keeps a settings write from
   * being arbitrary shell.
   */
  private template(raw: string, country: string | null): string[] | null {
    const substituted = raw.replaceAll('{{country}}', (country ?? '').toUpperCase());
    const argv = substituted.trim().split(/\s+/).filter((part) => part.length > 0);
    return argv.length > 0 ? argv : null;
  }

  /* ---------------------------------------------------------------------- */
  /* Spawning                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The only place this service starts a process. `execFile` with an argv array
   * — never `exec` with a shell string and never `shell: true` — because every
   * input here (country codes, connection prefixes, command templates) comes
   * from settings the dashboard can write.
   */
  private async spawn(
    vpn: VpnSettings,
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    // A connect that hangs must not hold the queue open forever; the extra
    // margin covers process startup on top of the backend's own wait.
    const timeout = Math.max(MIN_SPAWN_TIMEOUT_MS, vpn.connectTimeoutSeconds * 1000 + 10_000);
    const { stdout, stderr } = await run(command, args, {
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  }

  /** Turns a spawn failure into something the operator can act on. */
  private describeSpawnFailure(backend: VpnBackend, error: unknown): string {
    const message = toErrorMessage(error);
    if (/ENOENT/.test(message)) {
      const tool =
        backend === 'protonvpn'
          ? 'python3 (and the Proton VPN Linux app)'
          : backend === 'nmcli'
            ? 'nmcli (NetworkManager)'
            : backend === 'wg_quick'
              ? 'wg-quick (wireguard-tools)'
              : 'the configured command';
      return `${tool} is not installed or not on PATH.`;
    }
    if (/sudo|not permitted|Operation not permitted|must be run as root/i.test(message)) {
      return (
        `The ${backend} backend needs elevated privileges on this host. Grant the service ` +
        `user passwordless sudo for that command, or manage the tunnel through NetworkManager ` +
        `instead. (${message})`
      );
    }
    return message;
  }

  /* ---------------------------------------------------------------------- */
  /* Country list                                                           */
  /* ---------------------------------------------------------------------- */

  private async readCountries(vpn: VpnSettings): Promise<VpnCountryDto[]> {
    const cached = this.countryCache;
    if (cached && cached.backend === vpn.backend && Date.now() - cached.at < COUNTRY_CACHE_TTL_MS) {
      return cached.countries;
    }

    let countries: VpnCountryDto[];
    if (vpn.backend === 'protonvpn') {
      try {
        countries = await this.protonCountries(vpn);
      } catch (error) {
        this.logger.debug('could not list proton exit countries', {
          error: toErrorMessage(error),
        });
        countries = [];
      }
    } else {
      // The hand-configured backends have no catalogue: the only countries that
      // exist are the ones the user configured a profile for, and the server
      // count is unknowable, hence 0.
      countries = vpn.countries.map((code) => ({
        code: code.toUpperCase(),
        name: code.toUpperCase(),
        servers: 0,
      }));
    }

    this.countryCache = { at: Date.now(), backend: vpn.backend, countries };
    return countries;
  }

  /* ---------------------------------------------------------------------- */
  /* Rotation bookkeeping                                                   */
  /* ---------------------------------------------------------------------- */

  private appliesTo(vpn: VpnSettings, collectorId: string): boolean {
    return vpn.collectors.length === 0 || vpn.collectors.includes(collectorId);
  }

  private cooldownElapsed(vpn: VpnSettings): boolean {
    if (this.lastRotatedAtMs === null) return true;
    return Date.now() - this.lastRotatedAtMs >= vpn.minRotationSeconds * 1000;
  }

  private markRotated(): void {
    this.lastRotatedAtMs = Date.now();
    this.lastRotatedAt = nowIso();
  }

  /** The country the rotation is currently pointed at, without advancing it. */
  private currentCountry(vpn: VpnSettings): string | null {
    if (vpn.countries.length === 0) return null;
    return vpn.countries[this.rotationIndex % vpn.countries.length]?.toUpperCase() ?? null;
  }

  /** Advances the rotation and returns the next country, or null to let the backend pick. */
  private nextCountry(vpn: VpnSettings): string | null {
    if (vpn.countries.length === 0) return null;
    this.rotationIndex = (this.rotationIndex + 1) % vpn.countries.length;
    return this.currentCountry(vpn);
  }

  /* ---------------------------------------------------------------------- */
  /* Exit IP verification                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Confirms the exit actually moved.
   *
   * This is the one outbound call the whole feature makes, which is why it is
   * off by default and the endpoint is the user's to choose. A failure here is
   * never allowed to fail a connect: the tunnel is up either way, and an
   * IP-echo service being down says nothing about the tunnel.
   */
  private async verifyExitIp(vpn: VpnSettings): Promise<void> {
    if (!vpn.verifyExitIp || !vpn.exitIpEndpoint) {
      this.exitIp = null;
      return;
    }
    try {
      const response = await fetch(vpn.exitIpEndpoint, {
        signal: AbortSignal.timeout(EXIT_IP_TIMEOUT_MS),
        headers: { accept: 'application/json, text/plain' },
      });
      const body = await response.text();
      this.exitIp = extractIp(body);
    } catch (error) {
      this.exitIp = null;
      this.logger.debug('exit ip verification failed', { error: toErrorMessage(error) });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* DTO                                                                    */
  /* ---------------------------------------------------------------------- */

  private toDto(
    vpn: VpnSettings,
    backendStatus: BackendStatus,
    countries: VpnCountryDto[],
  ): VpnStatusDto {
    return {
      enabled: vpn.enabled,
      backend: vpn.backend,
      available: backendStatus.available,
      unavailableReason: backendStatus.unavailableReason,
      connected: backendStatus.connected,
      country: backendStatus.country,
      serverName: backendStatus.serverName,
      exitIp: vpn.verifyExitIp ? this.exitIp : null,
      lastRotatedAt: this.lastRotatedAt,
      lastError: this.lastError,
      rotation: vpn.countries.map((code) => code.toUpperCase()),
      countries,
    };
  }
}

/**
 * Pulls an address out of an IP-echo response. The endpoints in the wild return
 * either bare text, `{"ip":"..."}` or Proton's own `{"IP":"..."}`, so this
 * matches the address itself rather than trusting a field name.
 */
function extractIp(body: string): string | null {
  const v4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(body);
  if (v4?.[0]) return v4[0];
  const v6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/i.exec(body);
  return v6?.[0] ?? null;
}
