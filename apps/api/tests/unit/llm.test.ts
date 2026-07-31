import { describe, it, expect } from 'vitest';
import { LLM_TASKS, LLM_OUTPUT_SCHEMAS, type LlmTask } from '@deedy/shared';
import { extractJson, jsonSchemaFor } from '../../src/services/llm/llm.service.js';
import { DEFAULT_PROMPTS, renderTemplate } from '../../src/services/llm/prompts.js';
import { LlmError } from '../../src/core/errors.js';

describe('extractJson', () => {
  it('extracts a plain JSON object', () => {
    expect(extractJson('{"ok":true}')).toBe('{"ok":true}');
  });

  // Reasoning models put draft JSON inside <think>, which must never be parsed
  // as the answer.
  it('ignores JSON drafted inside a thinking block', () => {
    const raw =
      '<think>Maybe {"score": 10} or {"score": 20}? Let me reconsider.</think>\n{"score":85}';
    expect(JSON.parse(extractJson(raw))).toEqual({ score: 85 });
  });

  it('ignores a <thinking> block spelled out in full', () => {
    const raw = '<thinking>{"wrong":1}</thinking> {"right":2}';
    expect(JSON.parse(extractJson(raw))).toEqual({ right: 2 });
  });

  it('handles a thinking block wrapped around a fenced answer', () => {
    const raw = '<think>hmm {"a":1}</think>\n```json\n{"b":2}\n```';
    expect(JSON.parse(extractJson(raw))).toEqual({ b: 2 });
  });

  it('throws when generation stopped inside an unterminated thinking block', () => {
    expect(() => extractJson('<think>still deciding {"partial":')).toThrow();
  });

  it('unwraps a ```json fenced block', () => {
    const raw = '```json\n{"score": 42}\n```';
    expect(JSON.parse(extractJson(raw))).toEqual({ score: 42 });
  });

  it('unwraps a bare fenced block with no language tag', () => {
    const raw = '```\n{"score": 7}\n```';
    expect(extractJson(raw)).toBe('{"score": 7}');
  });

  it('prefers the fenced block even when prose surrounds it', () => {
    const raw = 'Here you go:\n```json\n{"a":1}\n```\nHope that helps.';
    expect(extractJson(raw)).toBe('{"a":1}');
  });

  it('strips prose before and after an unfenced object', () => {
    const raw = 'Sure! The result is {"a":1,"b":2} - let me know if you need more.';
    expect(extractJson(raw)).toBe('{"a":1,"b":2}');
  });

  it('keeps nested braces balanced and stops at the matching close brace', () => {
    const raw = 'Result: {"a":{"b":{"c":[1,2]}},"d":true} trailing {"other":1}';
    expect(extractJson(raw)).toBe('{"a":{"b":{"c":[1,2]}},"d":true}');
    expect(JSON.parse(extractJson(raw))).toEqual({ a: { b: { c: [1, 2] } }, d: true });
  });

  it('ignores braces that appear inside string values', () => {
    const raw = '{"template":"use {{name}} here","closing":"}"}';
    expect(extractJson(raw)).toBe(raw);
    expect(JSON.parse(extractJson(raw))).toEqual({
      template: 'use {{name}} here',
      closing: '}',
    });
  });

  it('ignores escaped quotes when tracking string boundaries', () => {
    const raw = '{"quote":"he said \\"} not the end\\" ok"}';
    expect(extractJson(raw)).toBe(raw);
    expect(JSON.parse(extractJson(raw))).toEqual({ quote: 'he said "} not the end" ok' });
  });

  it('handles a trailing escaped backslash before the closing brace', () => {
    const raw = '{"path":"C:\\\\tmp\\\\"}';
    expect(JSON.parse(extractJson(raw))).toEqual({ path: 'C:\\tmp\\' });
  });

  it('throws for an unterminated object', () => {
    expect(() => extractJson('{"a": {"b": 1}')).toThrow(LlmError);
    expect(() => extractJson('{"a": {"b": 1}')).toThrow(/unterminated/i);
  });

  it('throws when a string is left open so the object never closes', () => {
    expect(() => extractJson('{"a": "never closed}')).toThrow(/unterminated/i);
  });

  it('throws when the response contains no object at all', () => {
    expect(() => extractJson('I could not complete that request.')).toThrow(LlmError);
    expect(() => extractJson('I could not complete that request.')).toThrow(/no JSON object/i);
  });

  it('throws for an empty response', () => {
    expect(() => extractJson('   ')).toThrow(/no JSON object/i);
  });

  it('throws when a fenced block holds a JSON array rather than an object', () => {
    expect(() => extractJson('```json\n[1,2,3]\n```')).toThrow(/no JSON object/i);
  });
});

describe('renderTemplate', () => {
  it('substitutes placeholders', () => {
    expect(renderTemplate('Hello {{name}} at {{company}}', { name: 'Ada', company: 'Acme' })).toBe(
      'Hello Ada at Acme',
    );
  });

  it('substitutes every occurrence of the same placeholder', () => {
    expect(renderTemplate('{{a}}-{{a}}-{{a}}', { a: 'x' })).toBe('x-x-x');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('Hi {{ name }} / {{  name  }}', { name: 'Ada' })).toBe('Hi Ada / Ada');
  });

  it('replaces a missing key with an empty string', () => {
    expect(renderTemplate('Title: {{title}}!', {})).toBe('Title: !');
  });

  it('preserves an empty-string value', () => {
    expect(renderTemplate('[{{v}}]', { v: '' })).toBe('[]');
  });

  it('leaves non-matching brace syntax untouched', () => {
    expect(renderTemplate('{{not-a-key}} {single} {{}}', { 'not-a-key': 'x' })).toBe(
      '{{not-a-key}} {single} {{}}',
    );
  });

  it('does not recursively expand substituted values', () => {
    expect(renderTemplate('{{outer}}', { outer: '{{inner}}', inner: 'boom' })).toBe('{{inner}}');
  });

  it('inserts multi-line values verbatim', () => {
    const description = 'Line one\nLine two';
    expect(renderTemplate('# Description\n{{description}}', { description })).toBe(
      '# Description\nLine one\nLine two',
    );
  });

  it('returns templates without placeholders unchanged', () => {
    expect(renderTemplate('no placeholders here', { name: 'Ada' })).toBe('no placeholders here');
  });
});

describe('LLM task coverage', () => {
  const tasks: LlmTask[] = [...LLM_TASKS];

  it.each(tasks)('task "%s" has a default prompt template', (task) => {
    const template = DEFAULT_PROMPTS[task];
    expect(template).toBeDefined();
    expect(template.system.trim().length).toBeGreaterThan(0);
    expect(template.user.trim().length).toBeGreaterThan(0);
  });

  it.each(tasks)('task "%s" has an output schema', (task) => {
    const schema = LLM_OUTPUT_SCHEMAS[task];
    expect(schema).toBeDefined();
    expect(typeof schema.parse).toBe('function');
    expect(typeof schema.safeParse).toBe('function');
  });

  it('defines no prompts or schemas for unknown tasks', () => {
    const known = new Set<string>(tasks);
    expect(Object.keys(DEFAULT_PROMPTS).filter((key) => !known.has(key))).toEqual([]);
    expect(Object.keys(LLM_OUTPUT_SCHEMAS).filter((key) => !known.has(key))).toEqual([]);
  });

  it('renders every default prompt without leaving placeholder markers', () => {
    // Every placeholder must be fillable; unfilled ones would reach the model as blanks.
    const placeholder = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
    for (const task of tasks) {
      const { system, user } = DEFAULT_PROMPTS[task];
      const combined = `${system}\n${user}`;
      const variables: Record<string, string> = {};
      for (const match of combined.matchAll(placeholder)) {
        const key = match[1];
        if (key) variables[key] = `value-${key}`;
      }
      const rendered = renderTemplate(combined, variables);
      expect(rendered).not.toMatch(placeholder);
    }
  });
});

describe('jsonSchemaFor', () => {
  // Grammar-based samplers reject string length bounds; Zod still enforces them.
  it('strips keywords that grammar samplers cannot compile', () => {
    const serialized = JSON.stringify(jsonSchemaFor('application_scoring'));
    expect(serialized).not.toContain('maxLength');
    expect(serialized).not.toContain('minLength');
    expect(serialized).not.toContain('pattern');
  });

  it('keeps the structural constraints the sampler needs', () => {
    const schema = jsonSchemaFor('application_scoring') as {
      type: string;
      required: string[];
      properties: Record<string, { type?: string; enum?: string[] }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(
      expect.arrayContaining(['score', 'recommendation', 'reasoning']),
    );
    expect(schema.properties.recommendation?.enum).toEqual([
      'apply',
      'skip',
      'manual_review',
    ]);
  });

  it('produces a compilable schema for every LLM task', () => {
    for (const task of LLM_TASKS) {
      const serialized = JSON.stringify(jsonSchemaFor(task));
      expect(serialized).not.toContain('maxLength');
      expect(serialized).not.toContain('$schema');
    }
  });

  it('still rejects an over-long string at validation time', () => {
    const result = LLM_OUTPUT_SCHEMAS.application_scoring.safeParse({
      score: 50,
      confidence: 0.5,
      matchedSkills: [],
      missingSkills: [],
      reasoning: 'x'.repeat(4001),
      recommendation: 'skip',
      redFlags: [],
    });
    expect(result.success).toBe(false);
  });
});
