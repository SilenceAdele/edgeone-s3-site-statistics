/**
 * Root entry (`/`). EdgeOne Pages maps only `index.ts` to the root path — the
 * catch-all `[[...path]].ts` does not cover "/", and static files take priority
 * — so without this file "/" never reaches the handler.
 */

export { onRequest } from './[[...path]].ts';