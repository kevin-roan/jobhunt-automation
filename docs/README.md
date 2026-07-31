# Documentation

Index of the Deedy Automation docs. Everything described here runs on one machine: there are no
cloud APIs, no CDNs, no telemetry and no external fonts anywhere in the platform.

## Contents

| Document | What it covers |
| --- | --- |
| [README.md](./README.md) | This index page. |
| [installation.md](./installation.md) | Getting a working instance up: prerequisites, Docker Compose install, `.env` and `ENCRYPTION_KEY`, ports, first-run configuration. |
| [deployment.md](./deployment.md) | Running it for real: container topology, the `/data` volume, resource sizing, reverse proxies, backups and upgrades. |
| [architecture.md](./architecture.md) | How the system is put together: layering rules, the autonomous loop, the application step machine and crash safety. |
| [database-schema.md](./database-schema.md) | Every SQLite table, column and index, plus the conventions shared by the SQL migration and the Drizzle schema. |
| [api.md](./api.md) | Prose reference for the REST surface: conventions, error envelope, pagination and each route group. The running server's `/docs` is the source of truth. |
| [developer-guide.md](./developer-guide.md) | Working on the codebase: workspace layout, the dev loop, code quality rules and recipes for adding an endpoint, a queue task, an LLM task, a migration or a test. |
| [plugin-guide.md](./plugin-guide.md) | Adding your own job providers as ESM collector plugins dropped into `DATA_DIR/plugins`, without touching core code. |

## Where to start

- **Just want to run it** - [installation.md](./installation.md), then [deployment.md](./deployment.md).
- **Want to understand it** - [architecture.md](./architecture.md), then [database-schema.md](./database-schema.md) and [api.md](./api.md).
- **Want to change it** - [developer-guide.md](./developer-guide.md), and [plugin-guide.md](./plugin-guide.md) if you are only adding a job source.
