/** Narrow standalone-host entrypoint: A2A HTTP server and workspace preflight only. */
export { createA2AServer } from './server.js';
export type { A2AServerOptions } from './server.js';
export { a2aPreflightInputSchema, a2aPreflightRequirementsSchema, a2aPreflightReportSchema, A2APreflightError, runA2APreflight } from './preflight.js';
