import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
// `?url` makes Vite emit the worker as a local asset and hand back its hashed
// path — the worker is served from this host like every other bundled file, so
// nothing is ever fetched from a CDN.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * An `<iframe src="…pdf">` does not render a PDF — it *asks the browser to*, and
 * the browser only obliges when it ships an internal PDF viewer that is also
 * enabled. Chrome-for-Testing (the Playwright build this project runs) is built
 * without it, and Firefox/Chromium both expose a "download PDFs instead of
 * opening them" preference. In every one of those cases the navigation inside
 * the frame turns into a download and the pane stays blank — which is exactly
 * the reported bug. So we decode and paint the PDF ourselves with pdf.js and
 * never hand a PDF URL to the browser's navigation machinery.
 */
type Status = 'loading' | 'ready' | 'failed';

/** Widest we ever rasterise, so a maximised pane cannot allocate a huge canvas. */
const MAX_RENDER_WIDTH = 2000;

// Default-exported so `React.lazy` can pull this module — and with it the ~1.5MB
// of pdf.js — out of the initial bundle; only opening the resume editor pays
// for it. Everything it loads is still emitted into `dist`, never fetched
// remotely.
export default function PdfPreview({
  url,
  className,
}: {
  url: string;
  className?: string;
}): JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const pagesRef = React.useRef<HTMLDivElement | null>(null);
  const docRef = React.useRef<PDFDocumentProxy | null>(null);
  const tasksRef = React.useRef<RenderTask[]>([]);

  /**
   * Every load and every re-render is stamped. Anything that resolves after the
   * stamp has moved on — a slow page from a superseded compile, a render still
   * running when the pane resizes — drops its result instead of painting over
   * the newer one.
   */
  const generation = React.useRef(0);

  const [status, setStatus] = React.useState<Status>('loading');
  const [width, setWidth] = React.useState(0);

  // The rasterised width has to come from the real box: a PDF page has no
  // intrinsic CSS size, so there is nothing to lay out against until measured.
  React.useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const paint = React.useCallback(async (stamp: number, cssWidth: number): Promise<void> => {
    const doc = docRef.current;
    const host = pagesRef.current;
    if (!doc || !host || cssWidth <= 0) return;

    // A render task keeps the canvas locked until it finishes or is cancelled,
    // so the previous pass must be retired before a new one touches anything.
    for (const task of tasksRef.current) task.cancel();
    tasksRef.current = [];

    // Painting more than one device pixel per CSS pixel is what keeps 9pt LaTeX
    // body text legible; the canvas is then scaled back down by CSS.
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const rendered: HTMLCanvasElement[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      if (stamp !== generation.current) return;

      const unscaled = page.getViewport({ scale: 1 });
      const target = Math.min(cssWidth, MAX_RENDER_WIDTH);
      const viewport = page.getViewport({ scale: (target / unscaled.width) * ratio });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.className = 'block w-full rounded-sm bg-white shadow-sm';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Resume page ${pageNumber} of ${doc.numPages}`);

      const task = page.render({ canvas, viewport });
      tasksRef.current.push(task);
      await task.promise;
      if (stamp !== generation.current) return;
      rendered.push(canvas);
    }

    // Swapped in one go: the old pages stay on screen for the whole re-render,
    // so resizing never flashes an empty pane.
    host.replaceChildren(...rendered);
  }, []);

  React.useEffect(() => {
    generation.current += 1;
    const stamp = generation.current;
    setStatus('loading');

    const task = getDocument({ url });
    void task.promise.then(
      async (doc) => {
        if (stamp !== generation.current) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        try {
          await paint(stamp, scrollRef.current?.clientWidth ?? 0);
          if (stamp === generation.current) setStatus('ready');
        } catch {
          if (stamp === generation.current) setStatus('failed');
        }
      },
      () => {
        if (stamp === generation.current) setStatus('failed');
      },
    );

    return () => {
      generation.current += 1;
      for (const render of tasksRef.current) render.cancel();
      tasksRef.current = [];
      docRef.current = null;
      // Destroying the loading task also tears down the document it produced,
      // which is what releases the worker's memory for this PDF.
      void task.destroy();
    };
  }, [url, paint]);

  // Re-rasterise on resize only; the document itself is untouched, so this must
  // not be folded into the loading effect or every drag would refetch the PDF.
  React.useEffect(() => {
    if (width <= 0 || !docRef.current) return;
    generation.current += 1;
    const stamp = generation.current;
    void paint(stamp, width).catch(() => {
      if (stamp === generation.current) setStatus('failed');
    });
  }, [width, paint]);

  return (
    <div className={className}>
      <div ref={scrollRef} className="scrollbar-thin size-full overflow-auto bg-muted/40 p-3">
        <div ref={pagesRef} className="flex flex-col gap-3" />
        {status === 'loading' ? (
          <p className="p-3 text-center text-xs text-muted-foreground">Rendering the PDF…</p>
        ) : null}
        {status === 'failed' ? (
          // The escape hatch, not a blank pane: whatever stopped in-page
          // rendering, the compiled PDF itself is still served at `url`.
          <div className="space-y-2 p-6 text-center text-xs text-muted-foreground">
            <p>This PDF could not be rendered in the page.</p>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-foreground underline underline-offset-2"
            >
              <ExternalLink className="size-3.5" />
              Open the PDF in a new tab
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
