/* eslint-disable prettier/prettier */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * A course video played through the API's own stream (see CoursesService.openVideoStream) is addressed by a signed token
 * instead of a storage link, because a `<video>` tag cannot send an Authorization header. The token only says "this
 * customer may watch this lesson until X": every request still re-checks access (refund, drip, plan) on the server, so
 * a leaked link stops working the moment access is revoked. Own `p` purpose: no other token can be used as one of these.
 */
const HOURS = 60 * 60 * 1000;
const secret = (): string => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
};
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export interface CourseStreamClaims { storeId: string; courseId: string; lessonId: string; customerId: string }

export function signCourseStreamToken(c: CourseStreamClaims, validForHours = 6): string {
  const body = b64(JSON.stringify({ s: c.storeId, c: c.courseId, l: c.lessonId, u: c.customerId, e: Date.now() + validForHours * HOURS, p: 'course_stream' }));
  return `${body}.${b64(createHmac('sha256', secret()).update(body).digest())}`;
}

/** The claims, or null when the token is malformed, forged, expired or made for something else. */
export function verifyCourseStreamToken(token: string): CourseStreamClaims | null {
  if (typeof token !== 'string' || token.length > 900) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p?.p !== 'course_stream' || typeof p.e !== 'number' || p.e < Date.now()) return null;
    if (![p.s, p.c, p.l, p.u].every((x) => typeof x === 'string' && x.length > 0)) return null;
    return { storeId: p.s, courseId: p.c, lessonId: p.l, customerId: p.u };
  } catch { return null; }
}
