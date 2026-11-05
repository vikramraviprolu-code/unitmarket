// POB-I1 (D-089, review findings): the proof that a publisher controls a web address. Pure readers only
// here (the database parts are in import-stage.state.test.ts). The token sits in ONE
// <meta name="unitmarket-verify" content="..."> tag in the head, or alone in the file
// /.well-known/unitmarket-verify.txt. Hostile pages are the point: a token that only appears where a
// stranger could have put it (a comment, a script, a visitor comment in the body) proves nothing.
import { describe, expect, it } from 'vitest';
import {
  PROOF_PATHS,
  WELL_KNOWN_PATH,
  normalizeHost,
  parseWebAddress,
  readProofToken,
  readWellKnownToken,
} from './domain-proof';

const T = 'umv-0123456789abcdef0123456789abcdef';
const meta = (content = T, attrs = 'name'): string =>
  `<meta ${attrs}="unitmarket-verify" content="${content}">`;
const page = (head: string, body = '<p>hi</p>'): string =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

describe('the two fixed paths', () => {
  it('are the front page and the well-known file, nothing else', () => {
    expect(WELL_KNOWN_PATH).toBe('/.well-known/unitmarket-verify.txt');
    expect(PROOF_PATHS).toEqual(['/', '/.well-known/unitmarket-verify.txt']);
  });
});

describe('readProofToken: the one good form', () => {
  it('reads the content of a name=unitmarket-verify meta tag in the head', () => {
    expect(readProofToken(page(meta()))).toBe(T);
  });
  it.each([
    ['upper case tag and attribute names', `<META NAME="unitmarket-verify" CONTENT="${T}">`],
    ['upper case value of name', `<meta name="UnitMarket-Verify" content="${T}">`],
    ['single quotes', `<meta name='unitmarket-verify' content='${T}'>`],
    ['unquoted attributes', `<meta name=unitmarket-verify content=${T}>`],
    ['content before name', `<meta content="${T}" name="unitmarket-verify">`],
    ['a self closing tag', `<meta name="unitmarket-verify" content="${T}" />`],
    [
      'white space and new lines inside the tag',
      `<meta\n  name="unitmarket-verify"\n  content="${T}"\n>`,
    ],
    [
      'other attributes around it',
      `<meta data-x="1" name="unitmarket-verify" id="v" content="${T}" data-y='>'>`,
    ],
  ])('%s', (_n, tag) => {
    expect(readProofToken(page(tag))).toBe(T);
  });

  it('works without a head element: meta tags before the first body element count', () => {
    expect(readProofToken(`<!doctype html><html>${meta()}<body></body></html>`)).toBe(T);
    expect(readProofToken(`${meta()}<p>x</p>`)).toBe(T);
  });
  it('a plain doctype, comments and white space before the tag are fine', () => {
    expect(readProofToken(`<!doctype html>\n<!-- a note -->\n<html>\n<head>\n${meta()}`)).toBe(T);
  });
  it('other head elements before it are fine (link, base, style with text, script with text)', () => {
    const head =
      '<link rel="icon" href="/x.ico"><base href="/"><style>a>b{color:red}</style>' +
      '<script>var a = "<meta name=unitmarket-verify>";</script>' +
      meta();
    expect(readProofToken(page(head))).toBe(T);
  });
});

describe('readProofToken: only name=, never property= or itemprop=', () => {
  it.each(['property', 'itemprop', 'http-equiv', 'id', 'class', 'data-name', 'content-name'])(
    '%s="unitmarket-verify" is not the proof',
    (attr) => {
      expect(readProofToken(page(meta(T, attr)))).toBeNull();
    },
  );
  it('a tag with the right name and no content is a tag that matched, and gives no token', () => {
    expect(readProofToken(page('<meta name="unitmarket-verify">'))).toBeNull();
    expect(readProofToken(page('<meta name="unitmarket-verify" content="">'))).toBeNull();
  });
  it('another meta name does not count', () => {
    expect(readProofToken(page(`<meta name="unitmarket-verify2" content="${T}">`))).toBeNull();
    expect(readProofToken(page(`<meta name="x-unitmarket-verify" content="${T}">`))).toBeNull();
    expect(readProofToken(page(`<meta name="description" content="${T}">`))).toBeNull();
  });
});

describe('readProofToken: exactly one tag may match', () => {
  it('two tags fail the proof, whether the tokens agree or not', () => {
    expect(readProofToken(page(meta() + meta()))).toBeNull();
    expect(readProofToken(page(meta() + meta('umv-ffffffffffffffffffffffffffffffff')))).toBeNull();
  });
  it('a second tag with a missing content still counts as a second tag', () => {
    expect(readProofToken(page(meta() + '<meta name="unitmarket-verify">'))).toBeNull();
  });
  it('a matching tag in a comment or a script is not counted, so the real one stands', () => {
    const head = `<!-- ${meta()} --><script>"${meta()}"</script>${meta()}`;
    expect(readProofToken(page(head))).toBe(T);
  });
  it('a property= twin does not make the proof ambiguous (it is not a match at all)', () => {
    expect(
      readProofToken(page(meta() + meta('umv-ffffffffffffffffffffffffffffffff', 'property'))),
    ).toBe(T);
  });
});

describe('readProofToken: nothing counts after the head', () => {
  it.each([
    ['after </head>', `<html><head></head>${meta()}<body></body></html>`],
    ['inside the body', page('', meta())],
    ['after the first body element', `<html><head></head><body><p>x</p>${meta()}</body></html>`],
    ['after a div with no head', `<div>x</div>${meta()}`],
    ['after a heading with no head', `<h1>Title</h1>${meta()}`],
    ['after plain text with no head', `Hello ${meta()}`],
    ['after an image', `<img src="x">${meta()}`],
    ['after an iframe', `<iframe src="x"></iframe>${meta()}`],
    [
      'after a visitor comment block',
      `<html><head></head><body><div class="comments"><p>Great! ${meta()}</p></div></body></html>`,
    ],
  ])('%s', (_n, html) => {
    expect(readProofToken(html)).toBeNull();
  });
  it('a tag before the end of the head counts even when the body follows at once', () => {
    expect(readProofToken(`<head>${meta()}</head><body></body>`)).toBe(T);
  });
});

describe('readProofToken: content inside these elements is not markup', () => {
  const hidden = meta();
  it.each([
    ['comment', `<!-- ${hidden} -->`],
    ['comment with dashes', `<!--- ${hidden} --->`],
    ['script', `<script>${hidden}</script>`],
    ['script with type', `<script type="text/template">${hidden}</script>`],
    ['uppercase script', `<SCRIPT>${hidden}</SCRIPT>`],
    ['style', `<style>${hidden}</style>`],
    ['title', `<title>${hidden}</title>`],
    ['textarea', `<textarea>${hidden}</textarea>`],
    ['noscript', `<noscript>${hidden}</noscript>`],
    ['template', `<template>${hidden}</template>`],
    ['nested noscript', `<noscript><noscript>${hidden}</noscript>${hidden}</noscript>`],
    ['nested template', `<template><template>${hidden}</template>${hidden}</template>`],
    ['noscript inside template', `<template><noscript>${hidden}</noscript>${hidden}</template>`],
    ['template inside noscript', `<noscript><template>${hidden}</template>${hidden}</noscript>`],
  ])('a tag inside a %s is skipped', (_n, head) => {
    expect(readProofToken(`<html><head>${head}</head></html>`)).toBeNull();
  });

  it('a skipped element closes where it should: the real tag after it counts', () => {
    expect(readProofToken(page(`<noscript><noscript>x</noscript></noscript>${hidden}`))).toBe(T);
    expect(readProofToken(page(`<template><template>x</template></template>${hidden}`))).toBe(T);
    expect(readProofToken(page(`<title>a</title>${hidden}`))).toBe(T);
  });

  it('an end tag of the wrong kind does not close a nested element', () => {
    expect(readProofToken(`<head><template><noscript></template>${hidden}</head>`)).toBeNull();
  });

  it('a comment cannot be closed early by a tag-like text, only by -->', () => {
    expect(readProofToken(`<head><!-- </head> ${hidden} -->`)).toBeNull();
    expect(readProofToken(`<head><!-- a --!> ${hidden} -->`)).toBeNull();
  });

  it('an element that never closes ends the scan: nothing after it is read', () => {
    for (const open of [
      '<!--',
      '<script>',
      '<style>',
      '<title>',
      '<textarea>',
      '<noscript>',
      '<template>',
      '<noscript><noscript></noscript>',
      '<meta name="x" content="',
      '<meta name="unitmarket-verify" content="' + T,
    ]) {
      expect(readProofToken(`<head>${open} ${hidden}`)).toBeNull();
    }
  });
  it('a tag found before the unclosed element still stands', () => {
    expect(readProofToken(`<head>${meta()}<script>never closed ${meta()}`)).toBe(T);
  });
});

describe('readProofToken: a token has a fixed shape', () => {
  it.each([
    '',
    'short',
    'a'.repeat(129),
    'umv-0123456789abcdef 0123456789abcdef',
    'umv-0123456789abcdef"x',
    'umv-0123456789abcdef&#x41;0123456789abcdef',
    'umv-<script>alert(1)</script>0123456789',
    'umv-0123456789abcdef\u0000abcdef0123456789',
  ])('refuses %j', (content) => {
    expect(readProofToken(page(`<meta name="unitmarket-verify" content='${content}'>`))).toBeNull();
  });
  it('trims no space: a token with spaces around it is not a token', () => {
    expect(readProofToken(page(`<meta name="unitmarket-verify" content=" ${T} ">`))).toBeNull();
  });
});

// No clock in a test (S6): the bound is the test timeout. A scan that is not linear would not finish in 10 s.
describe('readProofToken: hostile input is read in linear time', { timeout: 10_000 }, () => {
  const budget = (fn: () => void): void => {
    fn();
  };
  it('does not throw on odd values', () => {
    for (const v of [undefined, null, 5, {}, []] as unknown[])
      expect(readProofToken(v as string)).toBeNull();
    expect(readProofToken('')).toBeNull();
  });
  it('2 MB of angle brackets', () =>
    budget(() => expect(readProofToken('<'.repeat(2_000_000))).toBeNull()));
  it('2 MB of open comments', () =>
    budget(() => expect(readProofToken('<!--'.repeat(500_000))).toBeNull()));
  it('400000 nested noscript and template openings', () =>
    budget(() => {
      expect(readProofToken('<head>' + '<noscript><template>'.repeat(100_000) + meta())).toBeNull();
      expect(readProofToken('<head>' + '<noscript>'.repeat(300_000) + meta())).toBeNull();
    }));
  it('100000 meta tags that nearly match', () =>
    budget(() =>
      expect(
        readProofToken('<head>' + '<meta name="unitmarket-verify" '.repeat(100_000)),
      ).toBeNull(),
    ));
  it('100000 matching tags are many, not one', () =>
    budget(() => expect(readProofToken('<head>' + meta().repeat(100_000))).toBeNull()));
  it('an attribute value that never closes', () =>
    budget(() => expect(readProofToken('<head><meta name="' + 'a'.repeat(2_000_000))).toBeNull()));
  it('many script openings with no end', () =>
    budget(() => expect(readProofToken('<head>' + '<script>'.repeat(300_000))).toBeNull()));
  it('a tag whose name is a megabyte long', () =>
    budget(() => expect(readProofToken('<head><' + 'a'.repeat(2_000_000))).toBeNull()));
});

describe('readWellKnownToken', () => {
  it('reads one token on one line, with a trailing new line', () => {
    expect(readWellKnownToken(`${T}\n`)).toBe(T);
    expect(readWellKnownToken(T)).toBe(T);
    expect(readWellKnownToken(`${T}\r\n`)).toBe(T);
  });
  it.each([
    '',
    '\n',
    `${T}\n${T}`,
    `hello ${T}`,
    `${T} `,
    `<html>${T}</html>`,
    'x'.repeat(5000),
    `${T}\u0000`,
    `# comment\n${T}`,
  ])('refuses %j', (text) => {
    expect(readWellKnownToken(text)).toBeNull();
  });
  it('does not throw on odd values', () => {
    for (const v of [undefined, null, 5, {}] as unknown[])
      expect(readWellKnownToken(v as string)).toBeNull();
  });
});

describe('parseWebAddress: what a publisher may type', () => {
  it.each([
    ['https://shop.pub-one.invalid/catalogue', 'shop.pub-one.invalid', '/catalogue'],
    ['https://Shop.Pub-One.invalid', 'shop.pub-one.invalid', '/'],
    ['https://shop.pub-one.invalid:443/a?x=1', 'shop.pub-one.invalid', '/a?x=1'],
    ['https://shop.pub-one.invalid/feed.xml#top', 'shop.pub-one.invalid', '/feed.xml'],
    ['https://shop.pub-one.invalid./a', 'shop.pub-one.invalid', '/a'],
  ])('%s', (raw, host, path) => {
    expect(parseWebAddress(raw)).toEqual({ host, path, url: `https://${host}${path}` });
  });
  it.each([
    'http://shop.pub-one.invalid/',
    'shop.pub-one.invalid',
    '//shop.pub-one.invalid/',
    'ftp://shop.pub-one.invalid/',
    'https://user:pw@shop.pub-one.invalid/',
    'https://shop.pub-one.invalid:8443/',
    'https://127.0.0.1/',
    'https://169.254.169.254/computeMetadata/v1/',
    'https://[::1]/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://localhost/',
    'https://intranet/',
    'https://foo.localhost/',
    'https://shop.pub-one.invalid\\@evil.invalid/',
    'https:///x',
    'https://shop .pub-one.invalid/',
    'https://shop.pub-one.invalid/\u0000',
    `https://${'a'.repeat(300)}.invalid/`,
    `https://shop.pub-one.invalid/${'a'.repeat(2100)}`,
    '',
    ' https://shop.pub-one.invalid/',
  ])('refuses %j', (raw) => {
    expect(parseWebAddress(raw)).toBeNull();
  });
  it('never throws on a value that is not text', () => {
    for (const v of [undefined, null, 5, {}, []] as unknown[])
      expect(parseWebAddress(v)).toBeNull();
  });
});

describe('normalizeHost', () => {
  it.each([
    ['shop.pub-one.invalid', 'shop.pub-one.invalid'],
    ['SHOP.Pub-One.invalid', 'shop.pub-one.invalid'],
    ['shop.pub-one.invalid.', 'shop.pub-one.invalid'],
  ])('%s', (raw, want) => {
    expect(normalizeHost(raw)).toBe(want);
  });
  it.each([
    'localhost',
    'a.localhost',
    'intranet',
    '10.0.0.1',
    '0x7f.0.0.1',
    '2130706433',
    '[::1]',
    '*.pub-one.invalid',
    'shop.pub-one.invalid:443',
    'shop.pub-one.invalid/path',
    'shop pub-one.invalid',
    'a..b.invalid',
    '-a.b.invalid',
    'a-.b.invalid',
    'shop.pub-one.‮invalid',
    'münchen.invalid',
    `${'a'.repeat(64)}.invalid`,
    'a'.repeat(254),
    '',
  ])('refuses %j', (raw) => {
    expect(normalizeHost(raw)).toBeNull();
  });
  it('never throws on a value that is not text', () => {
    for (const v of [undefined, null, 5, {}, []] as unknown[]) expect(normalizeHost(v)).toBeNull();
  });
});
