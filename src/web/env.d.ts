// Global declarations for the web program. vite/client comes from tsconfig.web.json "types".

// Lets typescript-eslint resolve .vue imports in .ts files (vue-tsc understands them natively).
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface ViteTypeOptions {
  // Unknown import.meta.env keys become type errors instead of `any`.
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  /** Build-time only; vite.config.ts guarantees a non-empty default. */
  readonly VITE_SITE_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
