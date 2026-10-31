/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DDD_PARSER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
