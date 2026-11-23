import { BadRequestException } from '@nestjs/common';
import { validateBlockSettings, validateSectionSettings } from '../common/store-content/section-settings.validator';
import { deriveStoreSectionDef, sectionKeyFor, RESERVED_FIELD_KEYS, MAX_NODES } from './store-section-def.util';

const heading = (key = 'title', extra: Record<string, unknown> = {}) => ({ t: 'heading', key, label: 'Title', default: 'Hello', ...extra });
const root = (...children: unknown[]) => ({ t: 'stack', children });
const throws = (layout: unknown, re?: RegExp) => {
  try { deriveStoreSectionDef(layout); } catch (e: any) {
    expect(e).toBeInstanceOf(BadRequestException);
    if (re) expect(String(e.message)).toMatch(re);
    return;
  }
  throw new Error('expected the layout to be refused');
};

describe('deriveStoreSectionDef', () => {
  it('turns a layout into the form fields, starting values and block definition', () => {
    const d = deriveStoreSectionDef(root(
      heading('title'),
      { t: 'text', key: 'intro', label: 'Intro', default: 'Welcome' },
      { t: 'repeat', label: 'Card', initial: 3, cols: 3, card: true, children: [
        { t: 'image', key: 'photo', label: 'Photo' },
        heading('cardTitle', { label: 'Card title', default: 'Fast' }),
        { t: 'button', key: 'cta', label: 'Button', default: 'Read more' },
      ] },
    ));
    expect(d.fields.map(f => `${f.key}:${f.kind}`)).toEqual(['title:text', 'intro:textarea']);
    expect(d.block?.label).toBe('Card');
    expect(d.block?.fields.map(f => `${f.key}:${f.kind}`)).toEqual(['photo:image', 'cardTitle:text', 'cta:text', 'ctaLink:link']);
    expect(d.defaults).toEqual({ title: 'Hello', intro: 'Welcome' });
    expect(d.block?.defaults).toEqual({ cardTitle: 'Fast', cta: 'Read more' });
    expect(d.initialBlocks).toBe(3);
  });

  it('a section without a repeating group has no block', () => {
    const d = deriveStoreSectionDef(root(heading()));
    expect(d.block).toBeNull();
    expect(d.initialBlocks).toBe(0);
  });

  it('fills in sensible defaults for style choices and clamps nothing silently', () => {
    const d = deriveStoreSectionDef(root(heading(), { t: 'image', key: 'pic', label: 'P' }));
    const l: any = d.layout;
    expect(l).toMatchObject({ t: 'stack', gap: 16, align: 'left' });
    expect(l.children[0]).toMatchObject({ t: 'heading', size: 'md', align: 'inherit', tag: 'h2' });
    expect(l.children[1]).toMatchObject({ t: 'image', ratio: 'auto', fit: 'cover', radius: 0 });
    throws(root(heading('a', { size: 'huge' })), /size/);
    throws({ ...root(heading()), gap: 500 }, /gap/);
  });

  it('drops properties it does not know (the stored tree is only the allow-listed shape)', () => {
    const d = deriveStoreSectionDef(root({ ...heading(), onclick: 'alert(1)', style: 'x', html: '<b>' }));
    expect(JSON.stringify(d.layout)).not.toMatch(/onclick|alert|<b>/);
  });

  it('refuses a layout that does not start with a stack, or an unknown element', () => {
    throws({ t: 'columns', children: [] }, /vertical stack/);
    throws(root({ t: 'script', src: 'x' }), /unknown element/);
    throws(null);
    throws(root('not an object'));
  });

  it('field names: valid, unique, and never one the platform already uses', () => {
    throws(root(heading('Title')), /lowercase/);
    throws(root(heading('1abc')), /lowercase/);
    throws(root(heading('a'), heading('a')), /two elements/);
    for (const k of ['heading', 'sectionKey', 'customCss', 'animation', 'showTo', 'backgroundImageUrl']) {
      expect(RESERVED_FIELD_KEYS.has(k)).toBe(true);
      throws(root(heading(k)), /already used by the platform/);
    }
    // a button also owns <name>Link, so that name can not be taken twice
    throws(root({ t: 'button', key: 'cta' }, heading('ctaLink')), /two elements/);
  });

  it('one repeating group only, and not inside another', () => {
    const rep = () => ({ t: 'repeat', children: [heading('x1')] });
    throws(root({ ...rep(), children: [heading('r1')] }, { ...rep(), children: [heading('r2')] }), /only one repeating/);
    throws(root({ t: 'repeat', children: [{ t: 'repeat', children: [heading('r1')] }] }), /inside another/);
  });

  it('a container may hold containers, but only so deep and so many', () => {
    let deep: any = heading('leaf');
    for (let i = 0; i < 6; i++) deep = { t: 'stack', children: [deep] };
    throws({ t: 'stack', children: [deep] }, /too deeply/);
    const many = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ t: 'divider', i }));
    // 4 stacks of 19 dividers each: 81 elements, over the cap
    throws({ t: 'stack', children: Array.from({ length: 4 }, () => ({ t: 'stack', children: many.slice(0, 19) })) }, /at most 60 elements/);
  });

  it('needs at least one element and refuses text with markup', () => {
    throws(root(), /at least one element/);
    throws(root(heading('a', { default: '<script>x</script>' })), /< or >/);
    throws(root(heading('a', { label: 'x'.repeat(41) })), /40 characters/);
  });

  it('what it derives passes the platform validators a saved page section/block goes through', () => {
    const d = deriveStoreSectionDef(root(heading('title'), { t: 'repeat', children: [{ t: 'text', key: 'body', label: 'Body' }] }));
    const key = sectionKeyFor('Feature cards');
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, ...d.defaults, title: 'Hi' })).not.toThrow();
    expect(() => validateBlockSettings('theme_block', { blockKey: `${key}.item`, body: 'x' })).not.toThrow();
  });
});

describe('sectionKeyFor', () => {
  it('makes a safe unique-able key from a name', () => {
    expect(sectionKeyFor('Feature Cards!')).toBe('my.feature-cards');
    expect(sectionKeyFor('Feature Cards', 2)).toBe('my.feature-cards-2');
    expect(sectionKeyFor('!!!')).toBe('my.section');
    expect(sectionKeyFor('Äpfel & Öl')).toMatch(/^my\.[a-z0-9-]+$/);
    expect(sectionKeyFor('x'.repeat(80)).length).toBeLessThanOrEqual(33);
    expect(sectionKeyFor('Feature Cards')).toMatch(/^[a-z][a-z0-9_.-]{0,59}$/);
  });
});
