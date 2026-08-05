-- Resumes move from Markdown to LaTeX.
--
-- `latex` becomes the source of truth and `markdown` is demoted to a derived
-- plain-text mirror (kept because the scoring, ATS and cover-letter prompts all
-- read it, and because portals that want a .docx render from it). Existing rows
-- keep their Markdown; the service converts each one to LaTeX the first time it
-- is rendered or edited, so no content is lost and no boot-time backfill is
-- needed.

ALTER TABLE resumes ADD COLUMN latex TEXT NOT NULL DEFAULT '';
ALTER TABLE resumes ADD COLUMN theme TEXT NOT NULL DEFAULT '{}';
ALTER TABLE resumes ADD COLUMN template_id TEXT NOT NULL DEFAULT 'deedy-resume-openfont';
ALTER TABLE resumes ADD COLUMN tex_path TEXT;
ALTER TABLE resumes ADD COLUMN compile_log TEXT;
ALTER TABLE resumes ADD COLUMN compile_ok INTEGER NOT NULL DEFAULT 0;
