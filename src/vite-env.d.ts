/// <reference types="vite/client" />

// Custom env vars set at build time. Vite exposes them on `import.meta.env`.
interface ImportMetaEnv {
  /** Base URL for the API server. Empty in dev (Vite proxy), full origin in prod. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
