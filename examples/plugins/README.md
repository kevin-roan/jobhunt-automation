# Collector plugins

A collector plugin adds a new job source without touching core code. At boot the
API scans `DATA_DIR/plugins` (default `./data/plugins`) for files ending in
`.collector.js` or `.collector.mjs`, imports each one, and registers whatever it
exports. Plugins run inside the API process on your machine; nothing about them
phones home.

`remoteok.collector.mjs` in this directory is a complete, working example that
reads the public RemoteOK JSON feed. It needs no credentials and no board slugs.

## Install

1. Copy the file into the plugin directory:

   ```sh
   cp examples/plugins/remoteok.collector.mjs ./data/plugins/
   ```

   If you set `DATA_DIR` to something else, copy it into `$DATA_DIR/plugins`
   instead. In Docker, that path is inside the volume you bind-mounted.

2. Restart the API. Look for `collector plugins loaded` in the logs (and
   `collector registered` with `id: remoteok`). Load errors are logged as
   `failed to load collector plugin` with the file name and the reason.

3. Enable it in the UI under **Settings -> Search -> Enabled collectors**. If the enabled
   list is empty, every collector that has the configuration it needs runs
   automatically, so RemoteOK is picked up with no further action. As soon as you
   enable anything explicitly, that list becomes an allowlist and RemoteOK must
   be checked too.

To remove a plugin, delete the file and restart. To upgrade one, overwrite the
file and restart - modules are cached for the lifetime of the process.

## What a plugin must export

The default export (or a named `collectors` export, or an array of either) must
satisfy the `CollectorDefinition` shape from
`apps/api/src/collectors/types.ts`:

| Field            | Type                                            | Notes                                                                       |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `id`             | `string`                                        | Unique. Re-using a built-in id overwrites it.                                |
| `name`           | `string`                                        | Shown in the UI.                                                             |
| `source`         | `string`                                        | Stored on every job row; also the key under `settings.search.boards`.        |
| `description`    | `string`                                        | One line of help text for the settings screen.                               |
| `requiresAuth`   | `boolean`                                       | `true` if it needs a logged-in persistent browser profile.                   |
| `requiresBoards` | `boolean`                                       | `true` if it is useless without company slugs in `settings.search.boards`.   |
| `collect`        | `(context) => Promise<NormalizedJob[]>`         | Fetch and normalize only. Never write to the database.                       |

The registry validates `id`, `name`, `source` and `collect`; a module missing any
of them is skipped with a warning.

### The collect context

```js
context.settings // full Settings object; settings.search holds the user filters
context.logger   // scoped logger: trace/debug/info/warn/error
context.http     // getJson / getText / postJson with timeouts, retries, a real UA
context.browser  // Playwright BrowserManager, only created if you touch it
context.limit    // hard cap on how many jobs to return this run
context.signal   // AbortSignal for cancelled runs
```

Use `context.http` rather than bare `fetch` so you inherit the retry and timeout
behaviour, and always stop once `results.length >= context.limit`.

### The job shape

`collect` returns `NormalizedJob` objects
(`apps/api/src/repositories/job.repository.ts`). Required: `source`, `title`,
`company`, `applicationUrl`. Everything else is optional but strongly preferred:
`externalId`, `location`, `remoteType`, `employmentType`, `experienceLevel`,
`salaryMin`, `salaryMax`, `salaryCurrency`, `salaryPeriod`, `description`,
`descriptionHtml`, `postedAt` (ISO 8601), and `raw` (the untouched provider
payload, kept for debugging and re-parsing). De-duplication and persistence are
handled for you.

## Adapting the example

`remoteok.collector.mjs` is plain ESM on purpose: plugins are imported at
runtime, so they cannot import the app's TypeScript helpers. Everything it needs
is reimplemented locally in small functions you can copy as-is.

To point it at a different JSON feed:

1. Change `id`, `name`, `source`, `description` and `FEED_URL`.
2. Rewrite `normalize()` to map the provider's field names onto `NormalizedJob`.
   Keep `raw: posting` so nothing is lost.
3. Adjust `toPostings()` - the RemoteOK feed's first element is a legal notice,
   which most feeds do not have.
4. Keep `matchesFilters()` as is. It applies the user's keywords, excluded
   keywords, excluded companies and `postedWithinDays` window, which is what the
   built-in collectors do via `apps/api/src/collectors/normalize.ts`.
5. Set `requiresBoards: true` if your source is per-company, then read the slugs
   from `context.settings.search.boards[<your source>] ?? []` and loop over them,
   the way `greenhouse.collector.ts` does.

If your source needs a login, set `requiresAuth: true` and drive
`context.browser` instead of `context.http`; see `linkedin.collector.ts` for the
pattern.

### Guidelines

- Never throw out of `collect`. Log the failure with `context.logger.error` and
  return whatever you managed to collect - one broken source must not abort the
  whole run.
- Be polite to the upstream service: one request per run where possible, and
  respect the retry backoff built into `context.http`.
- No cloud APIs, no telemetry, no external analytics. Plugins must keep the
  system fully local.
