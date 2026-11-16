/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API's origin; leave unset to call the same origin the dashboard is served from. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "virtual:pwa-register" {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    /** Replaces the module's own reload. Called when a new worker takes control of this tab. */
    onNeedReload?: () => void;
    onOfflineReady?: () => void;
    onRegisterError?: (error: unknown) => void;
  }

  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
