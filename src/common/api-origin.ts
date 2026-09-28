/* eslint-disable prettier/prettier */

/**
 * Public origin of THIS API, for links in emails that must hit an `/api/*`
 * route (unsubscribe, click/open tracking, abandoned-cart recovery).
 *
 * Not `https://solvexo.store` — that host is the Vercel-hosted web app, whose
 * catch-all rewrite serves index.html for every path, so `/api/*` links on it
 * open the SPA instead of reaching the backend. API_PUBLIC_URL overrides it
 * for staging/local.
 */
export const API_PUBLIC_ORIGIN = (process.env.API_PUBLIC_URL || 'https://api.solvexo.store').replace(/\/+$/, '');
