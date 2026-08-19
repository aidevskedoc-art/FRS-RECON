/**
 * Base path for the Node.js + PostgreSQL backend's REST API.
 *
 * Left as a relative path so the dev server's proxy (proxy.conf.json) can
 * forward /api and /uploads to the backend on :4000 — same-origin in the
 * browser, so no CORS preflight and no environment-specific host baked
 * into the bundle. In production, serve the built frontend behind the same
 * origin as the API (or point a reverse proxy at it).
 */
export const API_BASE_URL = '/api';
