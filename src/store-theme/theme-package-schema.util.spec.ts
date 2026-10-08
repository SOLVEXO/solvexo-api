import { readThemePackageStructure } from './theme-package-schema.util';

describe('readThemePackageStructure', () => {
  it('reads section, block, template, and global setting schemas', () => {
    const structure = readThemePackageStructure([
      {
        path: 'sections/hero.liquid',
        encoding: 'utf8',
        content: `{% schema %}
        {
          // Merchant controls for this section.
          "name": "Hero",
          "settings": [{"type": "image_picker", "id": "image"}],
          "blocks": [{"type": "slide", "name": "Slide"}],
          "presets": [{"name": "Hero"}],
        }
        {% endschema %}`,
      },
      {
        path: 'blocks/text.liquid',
        encoding: 'utf8',
        content: `{% schema %}{"name":"Text","settings":[]} {% endschema %}`,
      },
      { path: 'templates/index.json', encoding: 'utf8', content: '{}' },
      { path: 'templates/product.json', encoding: 'utf8', content: '{}' },
      { path: 'sections/header-group.json', encoding: 'utf8', content: '{}' },
      {
        path: 'config/settings_schema.json',
        encoding: 'utf8',
        content: '[{"name":"Colors","settings":[]}]',
      },
    ]);

    expect(
      structure.components.map(({ kind, type, schema }) => ({
        kind,
        type,
        name: schema.name,
      })),
    ).toEqual([
      { kind: 'section', type: 'hero', name: 'Hero' },
      { kind: 'block', type: 'text', name: 'Text' },
    ]);
    expect(structure.components[0].schema.settings).toHaveLength(1);
    expect(structure.templates).toEqual(['index.json', 'product.json']);
    expect(structure.sectionGroups).toEqual(['sections/header-group.json']);
    expect(structure.themeSettings).toEqual([{ name: 'Colors', settings: [] }]);
  });

  it('does not treat comment-like text inside JSON strings as comments', () => {
    const structure = readThemePackageStructure([
      {
        path: 'sections/example.liquid',
        encoding: 'utf8',
        content: `{% schema %}{"name":"A // B","settings":[]} {% endschema %}`,
      },
    ]);

    expect(structure.components[0].schema.name).toBe('A // B');
  });

  it('rejects malformed or editor-incompatible section schemas', () => {
    expect(() =>
      readThemePackageStructure([
        {
          path: 'sections/broken.liquid',
          encoding: 'utf8',
          content: `{% schema %}{"name": {% endschema %}`,
        },
      ]),
    ).toThrow('sections/broken.liquid contains invalid section schema JSON');

    expect(() =>
      readThemePackageStructure([
        {
          path: 'sections/missing-name.liquid',
          encoding: 'utf8',
          content: `{% schema %}{"settings":[]} {% endschema %}`,
        },
      ]),
    ).toThrow('schema must be an object with a name');
  });
});
