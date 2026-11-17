/* eslint-disable prettier/prettier */
export interface CleanQuestion { askerName: string; askerEmail: string; question: string }

/** Strips tags/control characters and collapses spaces. Links are kept as plain text (never HTML). */
export function plainText(v: unknown, max: number): string {
  return String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/** Validates what a shopper typed. Throws Error with a message fit to show. A filled hidden "website" field means a bot. */
export function cleanQuestion(body: any): CleanQuestion {
  if (body?.website) throw new Error('Could not send your question');
  const askerName = plainText(body?.name, 60);
  const question = plainText(body?.question, 500);
  const askerEmail = plainText(body?.email, 160);
  if (askerName.length < 2) throw new Error('Please enter your name');
  if (question.length < 5) throw new Error('Please write your question (at least 5 characters)');
  if (askerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(askerEmail)) throw new Error('That email address does not look right');
  if ((question.match(/https?:\/\//gi) ?? []).length > 1) throw new Error('Please remove the extra links from your question');
  return { askerName, askerEmail, question };
}

export function cleanAnswer(v: unknown): string {
  const a = plainText(v, 1500);
  if (a.length < 1) throw new Error('Please write an answer');
  return a;
}
