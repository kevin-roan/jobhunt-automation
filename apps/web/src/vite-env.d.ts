/// <reference types="vite/client" />

/**
 * The dashboard talks to the API through the relative `/api` prefix, which the
 * Vite dev server proxies. `VITE_API_URL` only retargets that proxy (see
 * `vite.config.ts`), so it is optional and never baked into the bundle.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
