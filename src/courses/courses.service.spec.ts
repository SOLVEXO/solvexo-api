import { CoursesService } from './courses.service';
import { isUnlocked, sanitizeCourse, scoreQuiz } from './course.util';
import { FakeModel, makeDb, paidOrder } from '../digital-access/testing/fake-db.kit-spec';

const DAY = 86_400_000;
const body = {
  title: 'Intro', status: 'published', productId: 'p1',
  modules: [{ title: 'M1', lessons: [
    { title: 'Read', type: 'text', text: 'hello' },
    { title: 'Watch', type: 'video', videoPublicId: 'private/digital-products/v1', dripMode: 'days', unlockAfterDays: 3 },
    { title: 'Quiz', type: 'quiz', quiz: { passScore: 50, questions: [{ q: 'a?', options: ['x', 'y'], correctIndex: 1 }, { q: 'b?', options: ['x', 'y'], correctIndex: 0 }] } },
  ] }],
};

function setup() {
  const k = makeDb();
  const accessModel = new FakeModel({ status: 'active', downloadCount: 0, audit: [] });
  const courses = new FakeModel();
  const enrolls = new FakeModel({ progress: {}, completedAt: null, certificateId: null });
  const clean: any = sanitizeCourse(body);
  courses.rows.push({ _id: 'c1', storeId: 's1', ...clean });
  k.orderModel.rows.push(paidOrder({ sellerOrders: [{ storeId: 's1', items: [{ _id: 'i1', type: 'digital', productId: 'p1', status: 'pending' }] }] }));
  k.userModel.rows.push({ _id: 'c1', name: 'Ayesha Khan' });
  k.storeModel.rows.push({ _id: 's1', name: 'Demo Store' });
  const access: any = { accessModel, can: async (s: string, c: string, r: any) => {
    const a = accessModel.rows.find((x) => x.storeId === s && x.customerId === c && x.resourceRef === r.ref && x.status === 'active');
    if (a?.sourceOrderId && ['refunded', 'cancelled'].includes(k.orderModel.rows[0].sellerOrders[0].items[0].status)) { a.status = 'revoked'; return { allowed: false }; }
    return { allowed: !!a };
  } };
  const upload: any = { generateSignedUrl: (id: string, _t: string, secs: number) => `https://signed/${id}?exp=${secs}` };
  const memberships: any = { hasPlanAccess: async () => false };
  const svc = new CoursesService(k.db, upload, access, memberships, courses as any, enrolls as any);
  return { ...k, accessModel, courses, enrolls, svc, clean };
}

describe('course content rules', () => {
  it('keeps stable lesson ids and rejects unsafe media / bad quizzes', () => {
    const a: any = sanitizeCourse(body);
    const b: any = sanitizeCourse({ ...a });
    expect(b.modules[0].lessons[0].id).toBe(a.modules[0].lessons[0].id);
    const bad = (lesson: any) => () => sanitizeCourse({ title: 't', modules: [{ lessons: [lesson] }] });
    expect(bad({ type: 'video', videoPublicId: 'https://evil/x.mp4' })).toThrow('uploaded through');
    expect(bad({ type: 'file', filePublicId: 'private/kyc-documents/x' })).toThrow('uploaded through');
    expect(bad({ type: 'quiz', quiz: { questions: [{ q: 'a', options: ['x', 'y'], correctIndex: 5 }] } })).toThrow('correct answer');
    expect(bad({ type: 'exe' })).toThrow('Lesson type');
  });

  it('drip opens by date or N days after enrolling; quizzes score and pass', () => {
    const enrolled = new Date();
    expect(isUnlocked({ id: 'x', dripMode: 'days', unlockAfterDays: 3 }, enrolled, new Date(enrolled.getTime() + 2 * DAY))).toBe(false);
    expect(isUnlocked({ id: 'x', dripMode: 'days', unlockAfterDays: 3 }, enrolled, new Date(enrolled.getTime() + 3 * DAY))).toBe(true);
    expect(isUnlocked({ id: 'x', dripMode: 'date', unlockAt: new Date(Date.now() + DAY) }, enrolled)).toBe(false);
    const quiz = (sanitizeCourse(body) as any).modules[0].lessons[2].quiz;
    expect(scoreQuiz(quiz, [1, 0]).passed).toBe(true);
    expect(scoreQuiz(quiz, [1, 1]).score).toBe(50);
    expect(scoreQuiz(quiz, [0, 1]).passed).toBe(false);
  });
});

describe('CoursesService', () => {
  it('only a buyer of the course product gets in; other customer and other store do not', async () => {
    const s = setup();
    await expect(s.svc.outline('s1', 'c2', 'c1')).rejects.toThrow('do not have access');
    await expect(s.svc.outline('s2', 'c1', 'c1')).rejects.toThrow('Course not found');
    const o: any = await s.svc.outline('s1', 'c1', 'c1');
    expect(o.modules[0].lessons[0].text).toBe('hello');
    expect(s.accessModel.rows.length).toBe(1);
  });

  it('drip-locked lessons expose no content and no media; quiz answers never leave the server', async () => {
    const s = setup();
    const o: any = await s.svc.outline('s1', 'c1', 'c1');
    const watch = o.modules[0].lessons[1];
    expect(watch.locked).toBe(true);
    expect('videoPublicId' in watch).toBe(false);
    expect(JSON.stringify(o).includes('correctIndex')).toBe(false);
    await expect(s.svc.mediaUrl('s1', 'c1', 'c1', watch.id)).rejects.toThrow('not open yet');
    s.enrolls.rows[0].enrolledAt = new Date(Date.now() - 4 * DAY);
    const m: any = await s.svc.mediaUrl('s1', 'c1', 'c1', watch.id);
    expect(m.url.includes('private/digital-products/v1')).toBe(true);
    expect(m.expiresInSeconds).toBe(300);
  });

  it('completing every lesson (quiz needs a pass) mints one certificate; refund revokes access', async () => {
    const s = setup();
    const o: any = await s.svc.outline('s1', 'c1', 'c1');
    const [read, watch, quiz] = o.modules[0].lessons;
    s.enrolls.rows[0].enrolledAt = new Date(Date.now() - 4 * DAY);
    await expect(s.svc.complete('s1', 'c1', 'c1', quiz.id)).rejects.toThrow('Submit the quiz');
    await s.svc.complete('s1', 'c1', 'c1', read.id);
    await s.svc.complete('s1', 'c1', 'c1', watch.id);
    const bad: any = await s.svc.submitQuiz('s1', 'c1', 'c1', quiz.id, [0, 1]);
    expect(bad.passed).toBe(false);
    expect(s.enrolls.rows[0].completedAt).toBeNull();
    const good: any = await s.svc.submitQuiz('s1', 'c1', 'c1', quiz.id, [1, 0]);
    expect(good.completed).toBe(true);
    const id = s.enrolls.rows[0].certificateId;
    await s.svc.submitQuiz('s1', 'c1', 'c1', quiz.id, [1, 0]);
    expect(s.enrolls.rows[0].certificateId).toBe(id);
    const pdf = await s.svc.certificate('s1', 'c1', 'c1');
    expect(pdf.buffer.slice(0, 4).toString()).toBe('%PDF');
    expect(((await s.svc.verify(String(id).toLowerCase())) as any).name).toBe('Ayesha Khan');
    await expect(s.svc.verify('NOPE')).rejects.toThrow('Certificate not found');
    s.orderModel.rows[0].sellerOrders[0].items[0].status = 'refunded';
    await expect(s.svc.outline('s1', 'c1', 'c1')).rejects.toThrow('do not have access');
  });

  it('a store paused by the platform serves no course', async () => {
    const s = setup();
    s.storeModel.rows[0].digitalDisabled = true;
    await expect(s.svc.outline('s1', 'c1', 'c1')).rejects.toThrow('paused');
  });

  it('manual enrollment only for a customer of that store', async () => {
    const s = setup();
    s.userModel.rows.push({ _id: 'c5', storeId: 's1' }, { _id: 'cx', storeId: 's2' });
    await s.svc.manualEnroll('s1', 'c1', 'c5', 'seller');
    await expect(s.svc.manualEnroll('s1', 'c1', 'cx', 'seller')).rejects.toThrow('Customer not found');
    await expect(s.svc.manualEnroll('s2', 'c1', 'c5', 'seller')).rejects.toThrow('Course not found');
  });
});
