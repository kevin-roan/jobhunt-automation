#!/usr/bin/env python3
"""JSON-over-stdout bridge to the Proton VPN Linux client libraries.

Why this file exists at all: Proton dropped the scriptable `protonvpn-cli` on
Linux. What ships now is a GTK app (`protonvpn-app`) sitting on top of the
`proton-vpn-api-core` Python package, and that package is the only supported way
to drive a connection. Node cannot import it, so this script is the thinnest
possible adapter: one subcommand in, exactly one JSON object out.

What moving the exit IP actually buys the crawler:
  * Regional indexes. Indeed and friends serve a different result set per
    country, so searching "jobs in Berlin" from an Indian exit returns the wrong
    index entirely.
  * Rate limits. A single IP crawling all day gets throttled; spreading a slow
    crawl over a few exits keeps each one under the limit.

What it does NOT buy: anti-bot evasion. A serious bot-detection stack
fingerprints TLS, headers, timing and browser internals — the IP is one weak
signal among many, and Proton's ranges are well known datacentre ranges that
some sites score *worse* than a residential one. Rotating faster is not a
substitute for crawling politely; if a site says no, back off.

Contract with the Node caller (vpn.service.ts):
  * stdout receives exactly one JSON object and nothing else. Every log,
    warning and traceback goes to stderr.
  * exit 0 with {"ok": true, ...} on success.
  * exit non-zero with {"ok": false, "error": "..."} on failure.

Standalone use:
    python3 apps/api/assets/vpn/protonvpn_ctl.py status
    python3 apps/api/assets/vpn/protonvpn_ctl.py countries
    python3 apps/api/assets/vpn/protonvpn_ctl.py connect --country NL
    python3 apps/api/assets/vpn/protonvpn_ctl.py disconnect

Nothing here prints the account name, the session token or the credentials the
connection is built from. The only identifiers that ever reach stdout are the
public server name and its exit country.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
from typing import Any, Optional

# ISO 3166-1 alpha-2 -> display name, covering every exit country Proton has
# offered plus the odd historical one. Inlined deliberately: a country picker
# must not depend on a network lookup in a product whose whole premise is that
# nothing leaves the host.
COUNTRY_NAMES: dict[str, str] = {
    "AE": "United Arab Emirates", "AL": "Albania", "AM": "Armenia",
    "AR": "Argentina", "AT": "Austria", "AU": "Australia", "AZ": "Azerbaijan",
    "BA": "Bosnia and Herzegovina", "BD": "Bangladesh", "BE": "Belgium",
    "BG": "Bulgaria", "BH": "Bahrain", "BR": "Brazil", "BY": "Belarus",
    "CA": "Canada", "CH": "Switzerland", "CL": "Chile", "CO": "Colombia",
    "CR": "Costa Rica", "CY": "Cyprus", "CZ": "Czechia", "DE": "Germany",
    "DK": "Denmark", "DZ": "Algeria", "EC": "Ecuador", "EE": "Estonia",
    "EG": "Egypt", "ES": "Spain", "FI": "Finland", "FR": "France",
    "GE": "Georgia", "GH": "Ghana", "GR": "Greece", "HK": "Hong Kong",
    "HR": "Croatia", "HU": "Hungary", "ID": "Indonesia", "IE": "Ireland",
    "IL": "Israel", "IN": "India", "IS": "Iceland", "IT": "Italy",
    "JP": "Japan", "KE": "Kenya", "KH": "Cambodia", "KR": "South Korea",
    "KZ": "Kazakhstan", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia",
    "MA": "Morocco", "MD": "Moldova", "ME": "Montenegro",
    "MK": "North Macedonia", "MM": "Myanmar", "MT": "Malta", "MX": "Mexico",
    "MY": "Malaysia", "NG": "Nigeria", "NL": "Netherlands", "NO": "Norway",
    "NP": "Nepal", "NZ": "New Zealand", "PA": "Panama", "PE": "Peru",
    "PH": "Philippines", "PK": "Pakistan", "PL": "Poland", "PR": "Puerto Rico",
    "PT": "Portugal", "PY": "Paraguay", "QA": "Qatar", "RO": "Romania",
    "RS": "Serbia", "RU": "Russia", "SA": "Saudi Arabia", "SE": "Sweden",
    "SG": "Singapore", "SI": "Slovenia", "SK": "Slovakia", "TH": "Thailand",
    "TR": "Turkey", "TW": "Taiwan", "UA": "Ukraine", "UK": "United Kingdom",
    "US": "United States", "UY": "Uruguay", "VN": "Vietnam",
    "ZA": "South Africa",
}

# Named in every "unavailable" message so the operator is told the fix rather
# than left with a boolean.
SIGN_IN_HINT = (
    "Not signed in to Proton VPN on this host. Open the Proton VPN app "
    "(protonvpn-app) and sign in once; the session is cached at "
    "~/.cache/Proton/VPN and this helper reuses it."
)
MISSING_PACKAGES_HINT = (
    "The Proton VPN Python libraries are not installed. Install the Proton VPN "
    "Linux app (which pulls in python-proton-vpn-api-core) and sign in once."
)

# How often the connect loop re-reads the connector state while waiting.
POLL_INTERVAL_SECONDS = 0.5


def emit(payload: dict[str, Any]) -> None:
    """The single line of stdout this process is allowed to produce."""
    json.dump(payload, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    sys.stdout.flush()


def fail(message: str) -> int:
    emit({"ok": False, "error": message})
    return 1


def log(message: str) -> None:
    """Diagnostics go to stderr; stdout belongs to the JSON contract."""
    print(message, file=sys.stderr)


def unavailable(reason: str) -> dict[str, Any]:
    """A clean, parseable 'cannot work here' — never a traceback."""
    return {
        "ok": True,
        "available": False,
        "loggedIn": False,
        "connected": False,
        "country": None,
        "serverName": None,
        "reason": reason,
    }


def country_name(code: str, fallback: Optional[str] = None) -> str:
    return COUNTRY_NAMES.get(code.upper()) or fallback or code.upper()


def load_api() -> tuple[Optional[Any], Optional[str]]:
    """Constructs the Proton API object, or explains why it cannot be built.

    Both failure modes the caller cares about — packages absent, user signed
    out — come back as a reason string rather than an exception, because both
    are ordinary states of a workstation and neither deserves a stack trace in
    the dashboard.
    """
    try:
        # Import path note: it is proton.vpn.core.session_holder, NOT
        # proton.session.api. The latter exists and is a different package.
        from proton.vpn.core.session_holder import ClientTypeMetadata
        from proton.vpn.core.api import ProtonVPNAPI
    except Exception as error:  # ImportError, but a broken install raises others
        log(f"proton packages unavailable: {error}")
        return None, MISSING_PACKAGES_HINT

    try:
        api = ProtonVPNAPI(ClientTypeMetadata(type="cli", version="1.0"))
    except Exception as error:
        log(f"could not construct ProtonVPNAPI: {error}")
        return None, f"Could not initialise the Proton VPN client library: {error}"

    try:
        if not api.is_user_logged_in():
            return None, SIGN_IN_HINT
    except Exception as error:
        log(f"login check failed: {error}")
        return None, SIGN_IN_HINT

    return api, None


def usable_servers(api: Any) -> list[Any]:
    """Enabled servers this account's tier can actually connect to.

    Filtering by tier here rather than in the UI means a free account never sees
    a country it would only get an authorisation error from.
    """
    tier = api.user_tier or 0
    servers = []
    for server in api.server_list:
        try:
            if not server.enabled:
                continue
            if server.tier > tier:
                continue
            if getattr(server, "under_maintenance", False):
                continue
        except AttributeError:
            continue
        servers.append(server)
    return servers


def active_nm_tunnel() -> Optional[str]:
    """
    The Proton connection NetworkManager currently has up, by name, or None.

    This exists because `VPNConnector` rebuilds its state per process and reports
    `Disconnected` for a tunnel that a *previous* process established — which is
    every call we make, since each one is a fresh subprocess. Measured on this
    host: with `proton0` up and routing, a new connector still said Disconnected
    while NetworkManager correctly listed "ProtonVPN NL-FREE#120 … activated".
    NetworkManager owns the tunnel, so it is the honest source of truth.
    """
    try:
        result = subprocess.run(
            ["nmcli", "-t", "-f", "NAME,TYPE,DEVICE,STATE", "connection", "show", "--active"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None

    for line in result.stdout.splitlines():
        # NAME may itself contain ':' (server names do not, but be careful anyway).
        parts = line.rsplit(":", 3)
        if len(parts) != 4:
            continue
        name, _type, _device, state = parts
        if name.startswith("ProtonVPN ") and state == "activated":
            return name[len("ProtonVPN ") :].strip() or None
    return None


def describe(api: Any, connector: Any) -> dict[str, Any]:
    """The shared `status` shape, derived from the connector's current state."""
    connected = bool(connector.is_connected)
    server_name: Optional[str] = None
    code: Optional[str] = None

    server_id = connector.current_server_id
    if server_id:
        for server in api.server_list:
            if server.id == server_id:
                server_name = server.name
                code = (server.exit_country or "").upper() or None
                break

    # Only report a location while the tunnel is actually up: current_server_id
    # survives a disconnect (it is "the last server we used"), so trusting it
    # unconditionally would show a stale country on the dashboard.
    if not connected:
        server_name = None
        code = None

    # Fall back to NetworkManager when the connector has no memory of a tunnel
    # this process did not open. Without this the dashboard reports "direct"
    # while every packet on the machine is going through Proton.
    if not connected:
        nm_name = active_nm_tunnel()
        if nm_name:
            connected = True
            server_name = nm_name
            for server in api.server_list:
                if server.name == nm_name:
                    code = (server.exit_country or "").upper() or None
                    break
            # Proton names servers "<CC>-FREE#12" / "<CC>#7", so the prefix is a
            # dependable last resort when the cached list has moved on.
            if not code:
                prefix = nm_name.split("-")[0].split("#")[0].strip().upper()
                code = prefix if len(prefix) == 2 and prefix.isalpha() else None

    return {
        "ok": True,
        "available": True,
        "loggedIn": True,
        "connected": connected,
        "country": code,
        "serverName": server_name,
        "state": type(connector.current_state).__name__ if connector.current_state else None,
    }


def pick_server(api: Any, country: Optional[str]) -> tuple[Optional[Any], Optional[str]]:
    """Least-loaded usable server, optionally pinned to one exit country."""
    candidates = usable_servers(api)
    if country:
        wanted = country.upper()
        candidates = [s for s in candidates if (s.exit_country or "").upper() == wanted]
        if not candidates:
            return None, (
                f"No enabled Proton VPN server in {country_name(wanted)} ({wanted}) "
                f"is available on this account's tier."
            )
    if not candidates:
        return None, "No enabled Proton VPN server is available on this account's tier."

    # `load` is Proton's own 0-100 utilisation figure; `score` is their latency
    # weighting. Load is the one that matters for a crawler that just wants a
    # server that will not stall.
    candidates.sort(key=lambda s: (s.load if s.load is not None else 100, s.name or ""))
    return candidates[0], None


async def wait_until(connector: Any, predicate: Any, timeout: float) -> bool:
    """Polls the connector's state machine until it settles or time runs out.

    Polling rather than subscribing: the publisher callback would have to be
    bridged back onto this loop, and a half-second poll over a 60-second window
    costs nothing in a process that exits immediately afterwards.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
    return predicate()


async def cmd_status(api: Any) -> dict[str, Any]:
    connector = await api.get_vpn_connector()
    return describe(api, connector)


async def cmd_connect(api: Any, country: Optional[str], timeout: float) -> dict[str, Any]:
    server, reason = pick_server(api, country)
    if server is None:
        return {"ok": False, "error": reason}

    connector = await api.get_vpn_connector()
    vpn_server = connector.get_vpn_server(server, api.client_config)

    # Clear anything a previous process left up first. Without this, rotating
    # NL -> US left BOTH profiles active and autoconnecting, so taking one down
    # simply failed over to the other and the exit country appeared stuck.
    for name in teardown_nm_tunnels():
        log(f"replacing existing tunnel {name}")

    log(f"connecting to {server.name} ({server.exit_country}, load {server.load})")
    # protocol/backend left as None so the user's own Proton app settings decide
    # (WireGuard by default). Overriding them here would silently diverge from
    # what they configured in the GUI.
    await connector.connect(vpn_server, protocol=None, backend=None)

    connected = await wait_until(connector, lambda: connector.is_connected, timeout)
    result = describe(api, connector)
    if not connected:
        result["ok"] = False
        result["error"] = (
            f"Timed out after {int(timeout)}s waiting for the tunnel to come up "
            f"(last state: {result.get('state')})."
        )
    return result


def teardown_nm_tunnels() -> list[str]:
    """
    Brings down every active Proton connection through NetworkManager and
    disarms its autoconnect. Returns the names it took down.

    Needed because `connector.disconnect()` only knows about a tunnel THIS
    process opened, and every invocation is a fresh process — so a tunnel left
    by an earlier call would survive a disconnect and the machine would stay
    routed through the VPN with the dashboard unable to do anything about it.
    Measured on this host before the fix: disconnect reported success while
    `proton0` kept carrying the default route.

    The autoconnect flag matters just as much: Proton writes these profiles with
    `connection.autoconnect yes`, so a plain `down` is undone by NetworkManager
    within seconds. Disarm first, then take it down.
    """
    downed: list[str] = []
    try:
        listing = subprocess.run(
            ["nmcli", "-t", "-f", "UUID,NAME", "connection", "show", "--active"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return downed
    if listing.returncode != 0:
        return downed

    for line in listing.stdout.splitlines():
        uuid, _, name = line.partition(":")
        if not name.startswith("ProtonVPN "):
            continue
        # Always address by UUID: Proton reuses the server name across profiles,
        # and `nmcli ... id "<name>"` is ambiguous the moment there are two.
        for args in (
            ["connection", "modify", "uuid", uuid, "connection.autoconnect", "no"],
            ["connection", "down", "uuid", uuid],
        ):
            try:
                subprocess.run(
                    ["nmcli", *args], capture_output=True, text=True, timeout=20, check=False
                )
            except (OSError, subprocess.SubprocessError):
                pass
        downed.append(name)
    return downed


async def cmd_disconnect(api: Any, timeout: float) -> dict[str, Any]:
    connector = await api.get_vpn_connector()
    await connector.disconnect()
    await wait_until(connector, lambda: not connector.is_connected, timeout)

    # The connector reports success even when it never held the tunnel, so the
    # NetworkManager sweep is what actually guarantees we are back on the
    # normal route.
    downed = teardown_nm_tunnels()
    if downed:
        log(f"took down {len(downed)} Proton connection(s) via NetworkManager")

    return describe(api, connector)


def cmd_countries(api: Any) -> dict[str, Any]:
    counts: dict[str, int] = {}
    names: dict[str, str] = {}
    for server in usable_servers(api):
        code = (server.exit_country or "").upper()
        if not code:
            continue
        counts[code] = counts.get(code, 0) + 1
        if code not in names:
            names[code] = country_name(code, getattr(server, "exit_country_name", None))

    countries = [
        {"code": code, "name": names[code], "servers": count}
        for code, count in sorted(counts.items(), key=lambda item: names[item[0]])
    ]
    return {"ok": True, "countries": countries}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="protonvpn_ctl.py",
        description="JSON-over-stdout control of the Proton VPN Linux client.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="current tunnel state")
    sub.add_parser("countries", help="exit countries this account's tier can use")

    connect = sub.add_parser("connect", help="connect to the least-loaded server")
    connect.add_argument("--country", help="ISO 3166-1 alpha-2 exit country")
    connect.add_argument("--timeout", type=float, default=60.0)

    disconnect = sub.add_parser("disconnect", help="drop the tunnel")
    disconnect.add_argument("--timeout", type=float, default=30.0)

    args = parser.parse_args(argv)

    api, reason = load_api()
    if api is None:
        # An unusable backend is a legitimate answer, not an error: the
        # dashboard shows the reason and the fix. `countries` is the exception —
        # there is no honest empty list to return, so it degrades to an empty
        # one alongside the same reason.
        if args.command == "countries":
            emit({"ok": True, "countries": [], "available": False, "reason": reason})
        else:
            emit(unavailable(reason or "Proton VPN is unavailable on this host."))
        return 0

    try:
        if args.command == "status":
            result = asyncio.run(cmd_status(api))
        elif args.command == "countries":
            result = cmd_countries(api)
        elif args.command == "connect":
            result = asyncio.run(cmd_connect(api, args.country, args.timeout))
        elif args.command == "disconnect":
            result = asyncio.run(cmd_disconnect(api, args.timeout))
        else:  # argparse already rejects anything else
            return fail(f"unknown command: {args.command}")
    except Exception as error:
        # str(error) on a proton exception carries a server name at worst; the
        # traceback goes to stderr where it is useful and out of the JSON.
        import traceback

        traceback.print_exc(file=sys.stderr)
        return fail(f"{type(error).__name__}: {error}")

    emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
