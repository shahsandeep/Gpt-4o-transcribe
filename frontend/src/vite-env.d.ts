/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PYTHON_HOST?: string;
  readonly VITE_PYTHON_PORT?: string;
  readonly VITE_DOTNET_HOST?: string;
  readonly VITE_DOTNET_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
