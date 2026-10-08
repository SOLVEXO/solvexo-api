export interface ThemePackageSectionSchema {
  name: string;
  settings?: unknown[];
  blocks?: unknown[];
  presets?: unknown[];
  [key: string]: unknown;
}

export interface ThemePackageComponent {
  kind: 'section' | 'block';
  type: string;
  path: string;
  schema: ThemePackageSectionSchema;
}

export interface ThemePackageStructure {
  components: ThemePackageComponent[];
  templates: string[];
  sectionGroups: string[];
  themeSettings: unknown[];
}

export interface ThemePackageSourceFile {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
}

export function readThemePackageStructure(
  files: ThemePackageSourceFile[],
): ThemePackageStructure {
  const components: ThemePackageComponent[] = [];
  const templates = files
    .filter(
      (file) =>
        file.encoding === 'utf8' &&
        /^templates\/.+\.(json|liquid)$/i.test(file.path),
    )
    .map((file) => file.path.replace(/^templates\//i, ''))
    .sort();
  const sectionGroups = files
    .filter(
      (file) =>
        file.encoding === 'utf8' &&
        /^sections\/[^/]+\.json$/i.test(file.path),
    )
    .map((file) => file.path)
    .sort();

  for (const file of files) {
    if (file.encoding !== 'utf8') continue;
    const match = /^(sections|blocks)\/(.+)\.liquid$/i.exec(file.path);
    if (!match) continue;

    const schemaMatches = [
      ...file.content.matchAll(
        /\{%[-+]?\s*schema\s*[-+]?%\}([\s\S]*?)\{%[-+]?\s*endschema\s*[-+]?%\}/gi,
      ),
    ];
    if (schemaMatches.length !== 1) {
      throw new Error(`${file.path} must contain exactly one schema tag`);
    }

    let schema: unknown;
    try {
      schema = parseThemeJson(schemaMatches[0][1]);
    } catch {
      throw new Error(`${file.path} contains invalid section schema JSON`);
    }

    if (
      !schema ||
      typeof schema !== 'object' ||
      Array.isArray(schema) ||
      typeof (schema as Record<string, unknown>).name !== 'string'
    ) {
      throw new Error(`${file.path} schema must be an object with a name`);
    }

    const schemaRecord = schema as ThemePackageSectionSchema;
    for (const key of ['settings', 'blocks', 'presets'] as const) {
      if (
        schemaRecord[key] !== undefined &&
        !Array.isArray(schemaRecord[key])
      ) {
        throw new Error(`${file.path} schema "${key}" must be an array`);
      }
    }

    components.push({
      kind: match[1].toLowerCase() === 'sections' ? 'section' : 'block',
      type: match[2],
      path: file.path,
      schema: schemaRecord,
    });
  }

  const settingsFile = files.find(
    (file) =>
      file.encoding === 'utf8' &&
      file.path.toLowerCase() === 'config/settings_schema.json',
  );
  let themeSettings: unknown[] = [];
  if (settingsFile) {
    try {
      const parsed = parseThemeJson(settingsFile.content);
      if (!Array.isArray(parsed))
        throw new Error('settings schema must be an array');
      themeSettings = parsed;
    } catch {
      throw new Error(
        'config/settings_schema.json contains invalid theme settings JSON',
      );
    }
  }

  return { components, templates, sectionGroups, themeSettings };
}

function parseThemeJson(source: string): unknown {
  return JSON.parse(removeTrailingCommas(removeJsonComments(source)));
}

function removeJsonComments(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      )
        index += 1;
      if (index >= source.length) throw new Error('Unterminated JSON comment');
      index += 1;
      result += ' ';
    } else {
      result += char;
    }
  }

  return result;
}

function removeTrailingCommas(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === ',') {
      let next = index + 1;
      while (/\s/.test(source[next] ?? '')) next += 1;
      if (source[next] !== '}' && source[next] !== ']') result += char;
    } else {
      result += char;
    }
  }

  return result;
}
