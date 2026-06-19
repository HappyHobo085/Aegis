/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_AEGIS_AUTOPILOT?: string
  readonly VITE_AEGIS_AUTOPILOT_DISPLAY?: string
  readonly VITE_AEGIS_AUTOPILOT_FIXTURE?: string
}
interface ImportMeta { readonly env: ImportMetaEnv }
