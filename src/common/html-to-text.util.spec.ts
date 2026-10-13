import { htmlToPlainText } from './html-to-text.util';

describe('htmlToPlainText', () => {
  it('keeps link targets, drops tags and styles, decodes entities', () => {
    const out = htmlToPlainText('<style>p{color:red}</style><h2>Hi &amp; welcome</h2><p>Go: <a href="https://x.co/a?b=1">Accept Invite</a></p><p>Or <a href="https://y.co">https://y.co</a></p>');
    expect(out).toContain('Hi & welcome');
    expect(out).toContain('Accept Invite (https://x.co/a?b=1)');
    expect(out).toContain('https://y.co');
    expect(out).not.toMatch(/<|color:red/);
  });
  it('handles empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });
});
