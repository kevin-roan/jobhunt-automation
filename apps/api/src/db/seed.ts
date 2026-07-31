import { DEFAULT_PROMPTS } from '../services/llm/prompts.js';
import { loadConfig } from '../config/env.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { answerBank, promptTemplates, settings } from './schema.js';
import { encryptSecret } from '../core/crypto.js';
import { DEFAULT_SETTINGS, type LlmTask } from '@deedy/shared';
import { normalizeText } from '../core/utils.js';

/**
 * Seeds the defaults a fresh install needs: settings rows, the built-in prompt
 * templates as editable versions, and a starter answer bank. Idempotent.
 */
const SEED_ANSWERS: { question: string; answer: string; fieldType: string }[] = [
  { question: 'Are you legally authorized to work in this country?', answer: 'Yes', fieldType: 'radio' },
  { question: 'Will you now or in the future require sponsorship?', answer: 'No', fieldType: 'radio' },
  { question: 'Are you willing to relocate?', answer: 'No', fieldType: 'radio' },
  { question: 'How did you hear about this job?', answer: 'Company website', fieldType: 'select' },
  { question: 'Have you previously worked for this company?', answer: 'No', fieldType: 'radio' },
  { question: 'Do you have a valid work permit?', answer: 'Yes', fieldType: 'radio' },
];

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      Object.assign(out, flatten(val as Record<string, unknown>, path));
    } else {
      out[path] = val;
    }
  }
  return out;
}

function main(): void {
  const config = loadConfig();
  const { db, sqlite, close } = createDb(config.paths.db);

  try {
    runMigrations(sqlite);

    const flat = flatten(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
    let settingsSeeded = 0;
    for (const [key, value] of Object.entries(flat)) {
      const isSecret = key === 'llm.apiKey' || key === 'notifications.webhookUrl';
      const encoded =
        isSecret && typeof value === 'string' && value.length > 0
          ? encryptSecret(value, config.encryptionKey)
          : JSON.stringify(value);
      const result = db
        .insert(settings)
        .values({ key, value: encoded, encrypted: isSecret && String(value).length > 0 })
        .onConflictDoNothing()
        .run();
      settingsSeeded += result.changes;
    }

    let promptsSeeded = 0;
    for (const [task, template] of Object.entries(DEFAULT_PROMPTS)) {
      const result = db
        .insert(promptTemplates)
        .values({
          task: task as LlmTask,
          name: 'built-in',
          system: template.system,
          user: template.user,
          isActive: false,
          version: 1,
        })
        .onConflictDoNothing()
        .run();
      promptsSeeded += result.changes;
    }

    let answersSeeded = 0;
    for (const entry of SEED_ANSWERS) {
      const result = db
        .insert(answerBank)
        .values({
          normalized: normalizeText(entry.question),
          questionPattern: entry.question,
          answer: entry.answer,
          fieldType: entry.fieldType,
        })
        .onConflictDoNothing()
        .run();
      answersSeeded += result.changes;
    }

    process.stdout.write(
      `Seed complete — settings: ${settingsSeeded}, prompt templates: ${promptsSeeded}, answers: ${answersSeeded}\n`,
    );
  } finally {
    close();
  }
}

main();
