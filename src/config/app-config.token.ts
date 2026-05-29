/**
 * DI token for the structured, typed AppConfig object.
 *
 * Kept in its own side-effect-free module so importing the token never triggers
 * `ConfigModule.forRoot()` (which validates process.env). Services that inject
 * config can import this from anywhere — including unit tests — without forcing
 * a full env validation. `config.module.ts` re-exports it for backward compat.
 */
export const APP_CONFIG = 'APP_CONFIG';
