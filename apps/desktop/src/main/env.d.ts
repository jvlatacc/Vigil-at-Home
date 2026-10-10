/// <reference types="electron-vite/node" />

/** Short commit hash of the build, or '' when unknown (set in electron.vite.config.ts). */
declare const __VIGIL_COMMIT__: string;

/** The repo this build checks for updates, or null when checks are off — a fork
 * build (set in electron.vite.config.ts). */
declare const __VIGIL_UPDATE_REPO__: string | null;
