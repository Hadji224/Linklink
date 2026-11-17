/** Injecté par Vite (voir vite.config.ts) : « v1.1 · abc1234 ». */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Adresse du serveur si l'interface est hébergée séparément (sans slash final). */
  readonly VITE_API_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
