/* eslint-disable prettier/prettier */
import type { NextFunction, Request, Response } from 'express';

/**
 * NoSQL operator-injection guard. A JSON body such as `{ "email": { "$ne": null } }` turns a lookup like
 * `findOne({ email: body.email })` into "any email". No Solvexo client ever sends a key that starts with `$`, so a body
 * containing one anywhere is rejected with a 400 before it reaches a handler. Prototype-pollution keys (`__proto__`, and
 * `prototype` under `constructor`) are rejected the same way: they are behind several Mongoose casting advisories and no
 * legitimate payload uses them. Query strings use Express 5's simple parser
 * (no nested objects), so they cannot carry operators.
 *
 * Payment and integration webhooks are exempt: their bodies are written by the provider and are verified by signature
 * (they are never used as database filters).
 */
const MAX_DEPTH = 40;

/** The first `$`-prefixed or prototype-pollution key found in a parsed JSON value (path form, e.g. "email.$ne"), or null. */
export function findOperatorKey(value: unknown, path = '', depth = 0, parentKey = ''): string | null {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findOperatorKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (key.startsWith('$') || key === '__proto__' || (key === 'prototype' && parentKey === 'constructor')) return here;
    const hit = findOperatorKey((value as Record<string, unknown>)[key], here, depth + 1, key);
    if (hit) return hit;
  }
  return null;
}

export function isOperatorGuardExempt(url: string): boolean {
  const path = url.split('?')[0].toLowerCase();
  return path.includes('/webhook');
}

export function operatorKeyGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object' && !isOperatorGuardExempt(req.originalUrl || req.url)) {
    const key = findOperatorKey(req.body);
    if (key) {
      res.status(400).json({ statusCode: 400, message: `Field name not allowed: ${key.slice(0, 80)}`, error: 'Bad Request' });
      return;
    }
  }
  next();
}
