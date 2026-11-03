import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PRIVATE_ID } from '../products/digital-input.util';

export const MAX_MODULES = 50;
export const MAX_LESSONS = 100; // per module
export const MAX_QUESTIONS = 50;
const LESSON_TYPES = ['video', 'file', 'text', 'quiz'];
const DRIP = ['none', 'date', 'days'];
const newId = () => randomBytes(6).toString('hex');
const str = (v: any, max: number) => String(v ?? '').trim().slice(0, max);

export interface LessonLike {
  id: string;
  dripMode?: string;
  unlockAt?: Date | string | null;
  unlockAfterDays?: number | null;
}

/** Drip: a lesson opens on a fixed date, or N days after the learner enrolled. */
export function isUnlocked(l: LessonLike, enrolledAt: Date, now = new Date()): boolean {
  if (l.dripMode === 'date' && l.unlockAt) return now.getTime() >= new Date(l.unlockAt).getTime();
  if (l.dripMode === 'days' && l.unlockAfterDays != null) return now.getTime() >= enrolledAt.getTime() + l.unlockAfterDays * 86_400_000;
  return true;
}

export function unlockDate(l: LessonLike, enrolledAt: Date): Date | null {
  if (l.dripMode === 'date' && l.unlockAt) return new Date(l.unlockAt);
  if (l.dripMode === 'days' && l.unlockAfterDays != null) return new Date(enrolledAt.getTime() + l.unlockAfterDays * 86_400_000);
  return null;
}

/** answers[i] = chosen option index of question i. Returns percentage + pass flag. */
export function scoreQuiz(quiz: { questions: { correctIndex: number }[]; passScore: number }, answers: number[]): { score: number; passed: boolean } {
  const total = quiz.questions.length;
  if (!total) return { score: 0, passed: false };
  let right = 0;
  quiz.questions.forEach((q, i) => { if (Number.isInteger(answers?.[i]) && answers[i] === q.correctIndex) right++; });
  const score = Math.round((right / total) * 100);
  return { score, passed: score >= quiz.passScore };
}

export function certificateId(): string {
  return randomBytes(6).toString('hex').toUpperCase(); // 12 chars; the verify endpoint is the only lookup
}

const media = (v: any, label: string): string | null => {
  const s = str(v, 400);
  if (!s) return null;
  if (!PRIVATE_ID.test(s) || s.includes('..')) throw new BadRequestException(`${label} must be uploaded through the file uploader`);
  return s;
};

/** Allow-lists a seller-supplied course body. Existing module/lesson ids are kept so learner progress stays valid. */
export function sanitizeCourse(b: any) {
  const title = str(b?.title, 120);
  if (!title) throw new BadRequestException('Course title is required');
  const modulesIn = Array.isArray(b?.modules) ? b.modules : [];
  if (modulesIn.length > MAX_MODULES) throw new BadRequestException(`At most ${MAX_MODULES} modules`);
  const seen = new Set<string>();
  const uniq = (id: any) => { let v = /^[a-f0-9]{12}$/.test(String(id ?? '')) ? String(id) : newId(); while (seen.has(v)) v = newId(); seen.add(v); return v; };

  const modules = modulesIn.map((m: any, mi: number) => {
    const lessonsIn = Array.isArray(m?.lessons) ? m.lessons : [];
    if (lessonsIn.length > MAX_LESSONS) throw new BadRequestException(`At most ${MAX_LESSONS} lessons per module`);
    return {
      id: uniq(m?.id), title: str(m?.title, 120) || `Module ${mi + 1}`, position: mi,
      lessons: lessonsIn.map((l: any, li: number) => {
        const type = LESSON_TYPES.includes(l?.type) ? l.type : null;
        if (!type) throw new BadRequestException('Lesson type must be video, file, text or quiz');
        const dripMode = DRIP.includes(l?.dripMode) ? l.dripMode : 'none';
        const days = l?.unlockAfterDays == null || l.unlockAfterDays === '' ? null : Number(l.unlockAfterDays);
        if (dripMode === 'days' && (!Number.isInteger(days) || (days as number) < 0 || (days as number) > 3650)) throw new BadRequestException('unlockAfterDays must be a whole number of days');
        const at = l?.unlockAt ? new Date(l.unlockAt) : null;
        if (dripMode === 'date' && (!at || isNaN(at.getTime()))) throw new BadRequestException('unlockAt must be a valid date');
        const lesson: any = { id: uniq(l?.id), title: str(l?.title, 160) || `Lesson ${li + 1}`, type, position: li, dripMode, unlockAt: dripMode === 'date' ? at : null, unlockAfterDays: dripMode === 'days' ? days : null, text: '', videoPublicId: null, filePublicId: null, fileName: null, quiz: null };
        if (type === 'text') lesson.text = str(l?.text, 50_000);
        if (type === 'video') { lesson.videoPublicId = media(l?.videoPublicId, 'Video'); if (!lesson.videoPublicId) throw new BadRequestException('A video lesson needs a video'); }
        if (type === 'file') { lesson.filePublicId = media(l?.filePublicId, 'File'); if (!lesson.filePublicId) throw new BadRequestException('A file lesson needs a file'); lesson.fileName = str(l?.fileName, 200) || 'file'; }
        if (type === 'quiz') {
          const qs = Array.isArray(l?.quiz?.questions) ? l.quiz.questions : [];
          if (!qs.length || qs.length > MAX_QUESTIONS) throw new BadRequestException(`A quiz needs 1-${MAX_QUESTIONS} questions`);
          lesson.quiz = {
            passScore: Math.min(100, Math.max(0, Number(l.quiz.passScore ?? 70) || 0)),
            questions: qs.map((q: any) => {
              const options = (Array.isArray(q?.options) ? q.options : []).map((o: any) => str(o, 200)).filter(Boolean);
              const ci = Number(q?.correctIndex);
              if (options.length < 2 || options.length > 6 || !Number.isInteger(ci) || ci < 0 || ci >= options.length) throw new BadRequestException('Each question needs 2-6 options and a valid correct answer');
              return { q: str(q?.q, 500) || 'Question', options, correctIndex: ci };
            }),
          };
        }
        return lesson;
      }),
    };
  });
  const status = b?.status === 'published' ? 'published' : 'draft';
  return { title, description: str(b?.description, 2000), status, productId: str(b?.productId, 40) || null, requiresPlan: str(b?.requiresPlan, 40) || null, modules };
}
