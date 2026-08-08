import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { migrationsDir, runMigrations } from '../../src/db/migrate.js';
import { DEFAULT_PROMPTS } from '../../src/services/llm/prompts.js';

const MIGRATION = '0005_resume_tailoring_preservation.sql';

/** The wording that shipped before the preservation work, as an existing install holds it. */
const OLD_USER_PROMPT = `Rewrite this resume as a complete LaTeX document that targets the job below.

# Truthfulness rules
- Keep every employer, title, and date exactly as written in the source resume.
- Reorder and reword bullets to lead with the most relevant work.`;

let root: string;
let handle: DbHandle;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-prompt-migration-test-'));
  handle = createDb(path.join(root, 'deedy.sqlite'));
  runMigrations(handle.sqlite);
});

afterAll(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

describe(MIGRATION, () => {
  /**
   * Prompts are seeded into `prompt_templates`, and llm.service.ts prefers the
   * active row there over the built-in default — so editing prompts.ts alone
   * would leave every existing database tailoring with the old, unsafe wording.
   */
  it('rewrites a seeded built-in template and leaves a user template alone', () => {
    const insert = handle.sqlite.prepare(
      `INSERT INTO prompt_templates (task, name, system, user, is_active, version)
       VALUES (?, ?, ?, ?, 0, 1)`,
    );
    insert.run('resume_tailoring', 'built-in', 'old system', OLD_USER_PROMPT);
    insert.run('resume_tailoring', 'my-own', 'mine', 'mine, hands off');

    handle.sqlite.exec(readFileSync(path.join(migrationsDir(), MIGRATION), 'utf8'));

    const rows = handle.sqlite
      .prepare<[], { name: string; system: string; user: string }>(
        `SELECT name, system, user FROM prompt_templates WHERE task = 'resume_tailoring'`,
      )
      .all();

    const builtIn = rows.find((r) => r.name === 'built-in');
    const mine = rows.find((r) => r.name === 'my-own');

    // Byte-for-byte with the code default, or the DB and the source disagree
    // about what the model is being told.
    expect(builtIn?.system).toBe(DEFAULT_PROMPTS.resume_tailoring.system);
    expect(builtIn?.user).toBe(DEFAULT_PROMPTS.resume_tailoring.user);
    expect(builtIn?.user).not.toContain('Rewrite this resume');
    expect(builtIn?.user).toContain('VERBATIM');
    expect(builtIn?.user).toContain('{{missingKeywords}}');

    expect(mine?.user).toBe('mine, hands off');
  });
});
