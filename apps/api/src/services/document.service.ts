import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  type ISectionOptions,
} from 'docx';
import type { AppPaths } from '../config/env.js';
import type { Logger } from '../core/logger.js';
import { slugify } from '../core/utils.js';
import type { BrowserManager } from '../browser/browser.manager.js';

const PRINT_CSS = `
  @page { size: A4; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #111827;
    margin: 0;
  }
  h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: -0.01em; }
  h2 {
    font-size: 11.5pt;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 14pt 0 4pt;
    padding-bottom: 3pt;
    border-bottom: 0.75pt solid #d1d5db;
  }
  h3 { font-size: 10.5pt; margin: 9pt 0 1pt; }
  p { margin: 0 0 6pt; }
  ul { margin: 0 0 8pt; padding-left: 15pt; }
  li { margin-bottom: 2.5pt; }
  a { color: #1d4ed8; text-decoration: none; }
  strong { font-weight: 650; }
  hr { border: none; border-top: 0.75pt solid #d1d5db; margin: 10pt 0; }
  em { color: #4b5563; }
`;

export interface RenderedDocuments {
  markdownPath: string;
  pdfPath: string | null;
  docxPath: string | null;
}

/**
 * Turns Markdown into the artifacts an application actually needs: a PDF
 * (rendered with the bundled Chromium, so no LaTeX or system fonts required)
 * and a DOCX for portals that reject PDFs.
 */
export class DocumentService {
  constructor(
    private readonly paths: AppPaths,
    private readonly browser: BrowserManager,
    private readonly logger: Logger,
  ) {}

  markdownToHtml(markdown: string, title: string): string {
    const body = marked.parse(markdown, { async: false, gfm: true, breaks: false });
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
  }

  /** Writes .md, .pdf and .docx next to each other and returns their paths. */
  async render(input: {
    markdown: string;
    baseName: string;
    kind: 'resume' | 'cover-letter';
    title: string;
  }): Promise<RenderedDocuments> {
    const dir = input.kind === 'resume' ? this.paths.resumes : this.paths.coverLetters;
    const base = `${slugify(input.baseName)}-${Date.now()}`;

    const markdownPath = path.join(dir, `${base}.md`);
    await writeFile(markdownPath, input.markdown, 'utf8');

    let pdfPath: string | null = path.join(dir, `${base}.pdf`);
    try {
      await this.browser.renderPdf(this.markdownToHtml(input.markdown, input.title), pdfPath);
    } catch (error) {
      this.logger.error('pdf rendering failed', {
        base,
        error: error instanceof Error ? error.message : String(error),
      });
      pdfPath = null;
    }

    let docxPath: string | null = path.join(dir, `${base}.docx`);
    try {
      await writeFile(docxPath, await this.markdownToDocx(input.markdown, input.title));
    } catch (error) {
      this.logger.error('docx rendering failed', {
        base,
        error: error instanceof Error ? error.message : String(error),
      });
      docxPath = null;
    }

    return { markdownPath, pdfPath, docxPath };
  }

  /** Converts the Markdown subset resumes actually use into a clean DOCX. */
  async markdownToDocx(markdown: string, title: string): Promise<Buffer> {
    const children: Paragraph[] = [];

    for (const rawLine of markdown.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.trim().length === 0) continue;

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1]?.length ?? 1;
        children.push(
          new Paragraph({
            children: inlineRuns(heading[2] ?? ''),
            heading:
              level === 1
                ? HeadingLevel.HEADING_1
                : level === 2
                  ? HeadingLevel.HEADING_2
                  : HeadingLevel.HEADING_3,
            alignment: level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
            spacing: { before: level === 1 ? 0 : 180, after: 80 },
          }),
        );
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        children.push(
          new Paragraph({
            children: inlineRuns(bullet[1] ?? ''),
            bullet: { level: 0 },
            spacing: { after: 40 },
          }),
        );
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        children.push(
          new Paragraph({
            text: '',
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB' } },
          }),
        );
        continue;
      }

      children.push(new Paragraph({ children: inlineRuns(line), spacing: { after: 80 } }));
    }

    const section: ISectionOptions = {
      properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      children,
    };

    const document = new Document({
      title,
      creator: 'Deedy Automation',
      description: title,
      sections: [section],
    });

    return Packer.toBuffer(document);
  }
}

/** Handles `**bold**`, `*italic*` and `[text](url)` — the subset resumes use. */
function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|`[^`]+`)/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) runs.push(new TextRun({ text: text.slice(cursor, index) }));
    const token = match[0];

    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith('`')) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas' }));
    } else if (token.startsWith('[')) {
      const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      runs.push(new TextRun({ text: linkMatch?.[1] ?? token, color: '1D4ED8' }));
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    }
    cursor = index + token.length;
  }

  if (cursor < text.length) runs.push(new TextRun({ text: text.slice(cursor) }));
  return runs.length > 0 ? runs : [new TextRun({ text })];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
