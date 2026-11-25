/** Narrow standalone-host entrypoint: A2A HTTP server, workbench UI helpers and workspace preflight only. */
export { createA2AServer } from './server.js';
export type { A2AServerOptions } from './server.js';
export { a2aPreflightInputSchema, a2aPreflightRequirementsSchema, a2aPreflightReportSchema, A2APreflightError, runA2APreflight } from './preflight.js';
export { WorkbenchUi, WORKBENCH_UI_PATH, isAgentRequest, serveWorkbenchPage } from './workbench-ui.js';
