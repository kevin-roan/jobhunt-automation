# Contributing

Thanks for helping build Deedy Automation. This is a short, practical guide; the long-form
explanations live in [`docs/developer-guide.md`](docs/developer-guide.md) and
[`docs/plugin-guide.md`](docs/plugin-guide.md).

## The one rule that overrides everything

**Nothing leaves the host machine.** No cloud APIs, no CDNs, no external fonts, no analytics, no
telemetry, no crash reporters, no hardcoded model names. The only outbound traffic the platform may
make is to the job boards the user enabled and to the LLM endpoint the user configured. A pull
request that adds a remote dependency at runtime will not be merged.

---

## Setup

Requirements: Docker (recommended) or Node.js >= 22 with npm workspaces.

### Docker Compose (recommended)

```bash
git clone <your-fork> deedy-automation
cd deedy-automation
docker compose -f docker-compose.dev.yml up
```

That starts two containers with the repository bind-mounted and hot reload on both sides:

| Service | URL | What it runs |
| --- | --- | --- |
| `api` | http://localhost:8080 | `npm run dev -w @deedy/api` (tsx watch), Playwright browsers installed on first boot |
| `web` | http://localhost:5173 | `npm run dev -w @deedy/web` with `--host 0.0.0.0` |

Both build `@deedy/shared` first, because the API and the dashboard import their types from it.
Dev data (SQLite database, screenshots, artifacts, browser profiles) lives in the `dev-data` volume
mounted at `/data`; `node_modules` and the Playwright browser cache are named volumes, so the first
`up` is slow and every later one is fast.

The dashboard calls the API through the relative `/api` prefix and the Vite dev server proxies it.
`VITE_API_URL` (set to `http://localhost:8080` in the compose file) only retargets that proxy - it
is not baked into the bundle.

Useful variants:

```bash
docker compose -f docker-compose.dev.yml up --build          # after changing the Dockerfile
docker compose -f docker-compose.dev.yml exec api sh         # shell inside the API container
docker compose -f docker-compose.dev.yml down -v             # reset dev data and volumes
```

### On the host

```bash
npm install
npm run build -w @deedy/shared   # the other workspaces import its build output
npm run db:migrate
npm run dev                      # concurrently runs the API and the dashboard
```

`npm run db:seed` loads sample data if you want a populated dashboard to develop against.

---

## Code style

- **Strict TypeScript.** Every project extends `tsconfig.base.json`. Do not loosen compiler options
  in a workspace `tsconfig.json`.
- **`any` is banned** (`@typescript-eslint/no-explicit-any` is an error). Use `unknown` plus a type
  guard, or a real type. No `@ts-ignore`, no `@ts-expect-error` to silence a design problem.
- **`@deedy/shared` is the contract.** Types and Zod schemas shared by the API and the dashboard go
  in `packages/shared/src`; neither app redeclares them.
- **ESLint flat config** (`eslint.config.js`) also enforces inline type-only imports, `eqeqeq`,
  no unused variables (prefix intentionally unused ones with `_`), and `no-console` except
  `console.error` - use the injected logger instead.
- **Prettier** owns formatting: single quotes, semicolons, trailing commas, 100-column width, two
  space indent. Run `npm run format` before committing.
- **Comments explain why, not what.** Sparse and high value. Never use em-dashes in code, comments
  or docs; use a regular hyphen or restructure the sentence.
- **No placeholders.** No `TODO`, no stubbed functions, no dead code paths in merged work.
- **Conventional commit prefixes:** `feat:`, `fix:`, `refactor:`, `perf:`, `docs:`, `test:`,
  `chore:`, `build:`, `ci:`. Optional scope, for example `feat(collectors): add workable source`.
  Keep the subject imperative and under ~72 characters.

---

## Running the tests

| Command | Suite |
| --- | --- |
| `npm test` | Vitest, everything under `apps/api/tests` (unit + integration) |
| `npm run test -w @deedy/api` | the same suite, invoked directly |
| `npm run test:watch -w @deedy/api` | Vitest in watch mode while you iterate |
| `npm run test -w @deedy/api -- tests/unit` | unit tests only (`collectors`, `core`, `llm`) |
| `npm run test -w @deedy/api -- tests/integration` | integration tests (API routes, repositories, queue, settings, form filler) |
| `npm run test:e2e` | Playwright browser tests in `apps/web/tests/e2e` |

Integration tests use a throwaway SQLite database and never touch your `DATA_DIR`. The Playwright
suite needs the dev servers reachable - start `npm run dev` (or the dev compose stack) first, and
run `npx playwright install` once on the host if you are not using Docker.

Static checks:

```bash
npm run typecheck    # tsc across every workspace
npm run lint         # eslint . (npm run lint:fix to autofix)
npm run format:check # prettier
```

---

## Pull request checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes with no new warnings, and `npm run format:check` is clean.
- [ ] `npm test` passes, and `npm run test:e2e` passes if you touched the dashboard.
- [ ] New behaviour has a test. Bug fixes have a regression test.
- [ ] Docs updated: `README.md` for user-visible features, `docs/api.md` for endpoint changes,
      `docs/database-schema.md` for schema changes, `docs/plugin-guide.md` for collector or applier
      changes.
- [ ] **Schema changed?** A new migration was added. Edit `apps/api/src/db/schema.ts` *and* add a
      new numbered file in `apps/api/migrations` (for example `0002_add_x.sql`) - migrations are
      applied in lexicographic order and recorded in `_migrations`, so never edit an already
      released one. Verify with `npm run db:migrate`.
- [ ] No new outbound network calls, bundled remote assets or hardcoded model names.
- [ ] No secrets, `.env` files or contents of `DATA_DIR` committed.

---

## Adding a collector or an applier

**Collectors** (job sources) live in `apps/api/src/collectors/`. Implement the
`CollectorDefinition` interface from `types.ts`, normalise results through `normalize.ts`, and
register the definition in the `BUILT_IN` array in `registry.ts`. Cover it in
`apps/api/tests/unit/collectors.test.ts` against fixture payloads rather than the live board.

**Appliers** (ATS submission flows) live in `apps/api/src/browser/appliers/`. Most ATSs need no new
code: build one with `createFormApplier` (single page form) or `createWizardApplier` (multi-step
flow) in `index.ts`, giving it host patterns plus the apply, next and submit selectors and the
confirmation patterns, then add it to that file's `BUILT_IN` array. Only write a bespoke module if
neither factory can express the flow.

If you do not want to modify core code at all, ship a collector as a runtime plugin instead: drop
an ESM `*.collector.js` module into `DATA_DIR/plugins` and restart the API. See
[`docs/plugin-guide.md`](docs/plugin-guide.md) for the discovery rules, the full interface and a
complete example.
