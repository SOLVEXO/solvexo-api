import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { DigitalAccessService } from '../digital-access/digital-access.service';
import { MembershipsService } from '../memberships/memberships.service';
import { Course, CourseDocument, CourseEnrollment, EnrollmentDocument } from './course.schema';
import { certificateId, isUnlocked, sanitizeCourse, scoreQuiz, unlockDate } from './course.util';

const DEAD_ITEM = ['cancelled', 'refunded'];
const MEDIA_URL_SECONDS = 300;
const latin = (s: string) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?'); // standard PDF fonts cannot draw other scripts

@Injectable()
export class CoursesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly upload: UploadService,
    private readonly access: DigitalAccessService,
    private readonly memberships: MembershipsService,
    @InjectModel(Course.name) readonly courseModel: Model<CourseDocument>,
    @InjectModel(CourseEnrollment.name) readonly enrollModel: Model<EnrollmentDocument>,
  ) {}

  // ---------------- seller ----------------

  create(storeId: string, body: any) { return this.courseModel.create({ storeId, ...sanitizeCourse(body) }); }

  async update(storeId: string, id: string, body: any) {
    const c = await this.courseModel.findOne({ _id: id, storeId }).catch(() => null);
    if (!c) throw new NotFoundException('Course not found');
    Object.assign(c, sanitizeCourse({ ...c.toObject(), ...body }));
    c.markModified('modules');
    return c.save();
  }

  list(storeId: string) { return this.courseModel.find({ storeId }).select('title status productId requiresPlan updatedAt').sort({ createdAt: -1 }).lean(); }

  async get(storeId: string, id: string) {
    const c = await this.courseModel.findOne({ _id: id, storeId }).lean().catch(() => null);
    if (!c) throw new NotFoundException('Course not found');
    return c;
  }

  async enrollments(storeId: string, courseId: string) {
    const rows = await this.enrollModel.find({ storeId, courseId }).sort({ enrolledAt: -1 }).limit(200).lean();
    return rows.map((e) => ({ customerId: e.customerId, enrolledAt: e.enrolledAt, lessonsDone: Object.keys(e.progress ?? {}).length, completedAt: e.completedAt, certificateId: e.certificateId }));
  }

  /** Seller gives someone access (counts as a gift, no order). */
  async manualEnroll(storeId: string, courseId: string, customerId: string, by: string) {
    await this.get(storeId, courseId);
    const user: any = await (this.db.repositories as any).userModel.findOne({ _id: customerId, isDelete: { $ne: true } }).select('storeId').lean().catch(() => null);
    if (!user || (user.storeId && String(user.storeId) !== storeId)) throw new NotFoundException('Customer not found');
    await this.access.accessModel.updateOne(
      { storeId, customerId, resourceKind: 'course', resourceRef: courseId, sourceOrderItemId: '' },
      { $setOnInsert: { grantedBy: 'manual', status: 'active', audit: [{ at: new Date(), action: 'granted', by, note: 'manual enrollment' }] } },
      { upsert: true },
    );
    return { success: true };
  }

  // ---------------- access ----------------

  /** Paid order items of a course's product become course access (idempotent, like files). */
  private async grantFromOrders(storeId: string, customerId: string) {
    const courses = await this.courseModel.find({ storeId, status: 'published', productId: { $ne: null } }).select('productId').lean();
    if (!courses.length) return;
    const byProduct = new Map(courses.map((c) => [String(c.productId), String(c._id)]));
    const orders = await this.db.repositories.orderModel.find({ userId: customerId, isPaid: true, isDelete: false, 'sellerOrders.storeId': storeId, 'sellerOrders.items.productId': { $in: [...byProduct.keys()] } }).limit(200).lean();
    for (const o of orders as any[]) for (const so of o.sellerOrders ?? []) {
      if (so.storeId !== storeId) continue;
      for (const it of so.items ?? []) {
        const courseId = byProduct.get(String(it.productId));
        if (!courseId || DEAD_ITEM.includes(it.status)) continue;
        await this.access.accessModel.updateOne(
          { storeId, customerId, resourceKind: 'course', resourceRef: courseId, sourceOrderItemId: String(it._id) },
          { $setOnInsert: { grantedBy: 'purchase', sourceOrderId: String(o._id), status: 'active', audit: [{ at: new Date(), action: 'granted', by: 'system', note: 'paid order' }] } },
          { upsert: true },
        );
      }
    }
  }

  /** Published course + (purchase / manual access, or a plan that unlocks it). Creates the enrollment on first success. */
  private async gate(storeId: string, customerId: string, courseId: string) {
    const course = await this.courseModel.findOne({ _id: courseId, storeId, status: 'published' }).catch(() => null);
    if (!course) throw new NotFoundException('Course not found');
    const st: any = await this.db.repositories.storeModel.findOne({ _id: storeId }).select('digitalDisabled').lean();
    if (st?.digitalDisabled) throw new ForbiddenException('Digital delivery is paused for this store');
    await this.grantFromOrders(storeId, customerId);
    const r = await this.access.can(storeId, customerId, { kind: 'course', ref: courseId });
    const byPlan = !r.allowed && !!course.requiresPlan && (await this.memberships.hasPlanAccess(storeId, customerId, course.requiresPlan));
    if (!r.allowed && !byPlan) throw new ForbiddenException('You do not have access to this course');
    const enrollment = await this.enrollModel.findOneAndUpdate({ courseId, customerId }, { $setOnInsert: { storeId, enrolledAt: new Date(), progress: {} } }, { upsert: true, new: true });
    return { course, enrollment: enrollment as EnrollmentDocument };
  }

  // ---------------- learner ----------------

  async listMine(storeId: string, customerId: string) {
    await this.grantFromOrders(storeId, customerId);
    const accesses = await this.access.accessModel.find({ storeId, customerId, resourceKind: 'course', status: 'active' }).select('resourceRef').lean();
    const out: any[] = [];
    for (const a of accesses) {
      const c: any = await this.courseModel.findOne({ _id: a.resourceRef, storeId, status: 'published' }).lean().catch(() => null);
      if (!c) continue;
      const e = await this.enrollModel.findOne({ courseId: String(c._id), customerId }).lean();
      const total = c.modules.reduce((n: number, m: any) => n + m.lessons.length, 0);
      out.push({ courseId: String(c._id), title: c.title, description: c.description, lessons: total, done: Object.keys(e?.progress ?? {}).length, completed: !!e?.completedAt });
    }
    return out;
  }

  private lessonOf(course: CourseDocument, lessonId: string) {
    for (const m of course.modules) for (const l of m.lessons) if (l.id === lessonId) return l;
    throw new NotFoundException('Lesson not found');
  }

  /** The course outline. Locked (drip) lessons expose no content; quiz answers are never sent. */
  async outline(storeId: string, customerId: string, courseId: string) {
    const { course, enrollment } = await this.gate(storeId, customerId, courseId);
    const now = new Date();
    return {
      courseId, title: course.title, description: course.description, completed: !!enrollment.completedAt, certificateId: enrollment.certificateId,
      modules: course.modules.map((m: any) => ({
        id: m.id, title: m.title,
        lessons: m.lessons.map((l: any) => {
          const unlocked = isUnlocked(l, enrollment.enrolledAt, now);
          const base: any = { id: l.id, title: l.title, type: l.type, locked: !unlocked, unlockAt: unlocked ? null : unlockDate(l, enrollment.enrolledAt), completed: !!enrollment.progress?.[l.id], score: enrollment.progress?.[l.id]?.score ?? null };
          if (!unlocked) return base;
          if (l.type === 'text') base.text = l.text;
          if (l.type === 'file') base.fileName = l.fileName;
          if (l.type === 'quiz') base.quiz = { passScore: l.quiz.passScore, questions: l.quiz.questions.map((q: any) => ({ q: q.q, options: q.options })) };
          return base;
        }),
      })),
    };
  }

  private openLesson(course: CourseDocument, enrollment: EnrollmentDocument, lessonId: string) {
    const lesson = this.lessonOf(course, lessonId);
    if (!isUnlocked(lesson, enrollment.enrolledAt)) throw new ForbiddenException('This lesson is not open yet');
    return lesson;
  }

  /** Short-lived signed URL for a video or file lesson: never the raw storage URL. */
  async mediaUrl(storeId: string, customerId: string, courseId: string, lessonId: string) {
    const { course, enrollment } = await this.gate(storeId, customerId, courseId);
    const l = this.openLesson(course, enrollment, lessonId);
    if (l.type === 'video') return { url: this.upload.generateSignedUrl(l.videoPublicId, 'video', MEDIA_URL_SECONDS), expiresInSeconds: MEDIA_URL_SECONDS };
    if (l.type === 'file') return { url: this.upload.generateSignedUrl(l.filePublicId, 'raw', MEDIA_URL_SECONDS, l.fileName), expiresInSeconds: MEDIA_URL_SECONDS };
    throw new BadRequestException('This lesson has no media');
  }

  private async markDone(course: CourseDocument, enrollment: EnrollmentDocument, lessonId: string, score?: number) {
    const set: any = { [`progress.${lessonId}`]: { completedAt: new Date(), ...(score != null ? { score } : {}) } };
    await this.enrollModel.updateOne({ _id: enrollment._id }, { $set: set });
    const fresh: any = await this.enrollModel.findById(enrollment._id).lean();
    const all = course.modules.flatMap((m: any) => m.lessons.map((l: any) => l.id));
    const finished = all.length > 0 && all.every((id: string) => fresh.progress?.[id]);
    if (finished && !fresh.completedAt) {
      // conditional: only one request wins and mints the certificate id
      await this.enrollModel.updateOne({ _id: enrollment._id, completedAt: null }, { $set: { completedAt: new Date(), certificateId: certificateId() } });
    }
    const done = await this.enrollModel.findById(enrollment._id).lean();
    return { completed: !!done?.completedAt, certificateId: done?.certificateId ?? null, lessonsDone: Object.keys(done?.progress ?? {}).length };
  }

  async complete(storeId: string, customerId: string, courseId: string, lessonId: string) {
    const { course, enrollment } = await this.gate(storeId, customerId, courseId);
    const l = this.openLesson(course, enrollment, lessonId);
    if (l.type === 'quiz') throw new BadRequestException('Submit the quiz to complete this lesson');
    return this.markDone(course, enrollment, lessonId);
  }

  async submitQuiz(storeId: string, customerId: string, courseId: string, lessonId: string, answers: number[]) {
    const { course, enrollment } = await this.gate(storeId, customerId, courseId);
    const l = this.openLesson(course, enrollment, lessonId);
    if (l.type !== 'quiz') throw new BadRequestException('This lesson is not a quiz');
    if (!Array.isArray(answers) || answers.length > 100) throw new BadRequestException('answers must be a list of option numbers');
    const r = scoreQuiz(l.quiz, answers.map(Number));
    if (!r.passed) return { ...r, completed: false };
    return { ...r, ...(await this.markDone(course, enrollment, lessonId, r.score)) };
  }

  // ---------------- certificate ----------------

  async certificate(storeId: string, customerId: string, courseId: string): Promise<{ buffer: Buffer; fileName: string }> {
    const { course, enrollment } = await this.gate(storeId, customerId, courseId);
    if (!enrollment.completedAt || !enrollment.certificateId) throw new ForbiddenException('Finish the course to get your certificate');
    const [user, store]: any[] = await Promise.all([
      (this.db.repositories as any).userModel.findOne({ _id: customerId }).select('name').lean(),
      this.db.repositories.storeModel.findOne({ _id: storeId }).select('name').lean(),
    ]);
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([842, 595]);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const center = (t: string, y: number, size: number, f = font) => page.drawText(t, { x: (842 - f.widthOfTextAtSize(t, size)) / 2, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    page.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 2 });
    center('Certificate of Completion', 440, 34, bold);
    center('This certifies that', 385, 14);
    center(latin(user?.name || 'Student'), 335, 30, bold);
    center('has completed', 295, 14);
    center(latin(course.title).slice(0, 70), 250, 22, bold);
    center(latin(store?.name || ''), 205, 14);
    center(`Completed on ${enrollment.completedAt.toISOString().slice(0, 10)}`, 150, 12);
    center(`Certificate ID: ${enrollment.certificateId}`, 125, 12);
    return { buffer: Buffer.from(await pdf.save()), fileName: `certificate-${enrollment.certificateId}.pdf` };
  }

  /** Public: anyone holding the id can check it is real (name, course, date only). */
  async verify(id: string) {
    if (!/^[A-F0-9]{12}$/.test(String(id ?? '').toUpperCase())) throw new NotFoundException('Certificate not found');
    const e: any = await this.enrollModel.findOne({ certificateId: String(id).toUpperCase() }).lean();
    if (!e) throw new NotFoundException('Certificate not found');
    const [user, course]: any[] = await Promise.all([
      (this.db.repositories as any).userModel.findOne({ _id: e.customerId }).select('name').lean(),
      this.courseModel.findOne({ _id: e.courseId }).select('title').lean(),
    ]);
    return { valid: true, name: user?.name ?? null, course: course?.title ?? null, completedAt: e.completedAt };
  }
}
