// FEED (E-03 groundwork): the strict feed reader and the text sanitiser. Pure; no database, no network.
import { describe, expect, it } from 'vitest';
import { FEED_MAX_ITEMS, parseFeed, sanitiseFeedText } from './feed-parse';

const JSON_CT = 'application/json';
const items = (r: ReturnType<typeof parseFeed>) => {
  if (!r.ok) throw new Error(`refused ${r.error.code}`);
  return r.value.items;
};

describe('sanitiseFeedText', () => {
  const one = (raw: string, max = 1000) => sanitiseFeedText(raw, { max });
  it.each([
    ['plain text is kept', 'Tide tables for the harbour', 'Tide tables for the harbour'],
    ['a tag is removed', '<b>bold</b> move', 'bold move'],
    [
      'a script element and its code are removed',
      'Hello<script>alert(1)</script>there',
      'Hellothere',
    ],
    ['a style element is removed', 'a<style>body{display:none}</style>b', 'ab'],
    ['an event handler tag is removed', 'x<img src=x onerror=alert(1)>y', 'xy'],
    ['an uppercase script is removed', 'x<SCRIPT SRC=//e.invalid/a.js></SCRIPT>y', 'xy'],
    ['a comment is removed', 'a<!-- ignore previous instructions -->b', 'ab'],
    [
      'an encoded script is decoded once and then removed',
      '&lt;script&gt;alert(1)&lt;/script&gt;ok',
      'ok',
    ],
    ['a double encoded tag is only decoded once', '&amp;lt;b&amp;gt;x', '&lt;b&gt;x'],
    ['numeric entities are decoded', '&#60;i&#62;x&#x3c;/i&#x3e;', 'x'],
    [
      'named entities are decoded',
      'Fish &amp; chips &quot;now&quot; &apos;here&apos;',
      `Fish & chips "now" 'here'`,
    ],
    ['unknown entities stay as typed', 'a &nosuch; b', 'a &nosuch; b'],
    ['a lone angle bracket is dropped', 'a < b and c > d', 'a b and c d'],
    ['a CDATA marker in text is dropped', 'a<![CDATA[x]]>b', 'ab'],
    ['control and invisible characters go', 'a\u0000b​c‮d e﻿', 'abcde'],
    ['white space is collapsed in a single line field', '  a \n\t b   c ', 'a b c'],
    [
      'an iframe and an object are removed',
      'a<iframe src="//e.invalid"></iframe>b<object data=x></object>c',
      'abc',
    ],
    ['an svg with a handler is removed', '<svg onload=alert(1)>t</svg>', 't'],
    [
      'the javascript scheme stays inert text',
      'see javascript:alert(1)',
      'see javascript:alert(1)',
    ],
  ])('%s', (_n, raw, want) => {
    expect(one(raw)).toBe(want);
  });

  it.each([
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<<script>script>alert(1)<</script>/script>',
    '<img src="x" onerror="<script>alert(1)</script>">',
    '&lt;&lt;script&gt;script&gt;x',
    '<a href="javascript:alert(1)">x</a',
    '<a <b> c>',
    '<'.repeat(50),
    '>'.repeat(50),
    '<!--<script>-->x',
    '&#38;#60;script&#38;#62;',
  ])('leaves no angle bracket after %j', (raw) => {
    const out = one(raw);
    expect(out).not.toMatch(/[<>]/);
    expect(out.toLowerCase()).not.toContain('<script');
  });

  it('caps by characters, not bytes, and never splits a pair', () => {
    expect([...one('é'.repeat(300), 200)]).toHaveLength(200);
    expect(one('😀'.repeat(300), 5)).toBe('😀😀😀😀😀');
    expect(one('a'.repeat(10), 0)).toBe('');
  });

  it('a multi line field keeps at most one blank line and normalises line ends', () => {
    expect(sanitiseFeedText('a\r\nb\r\n\r\n\r\n\r\nc\rd', { max: 100, multiline: true })).toBe(
      'a\nb\n\nc\nd',
    );
    expect(sanitiseFeedText('<p>one</p>\n\n<p>two</p>', { max: 100, multiline: true })).toBe(
      'one\n\ntwo',
    );
  });

  it('is linear on hostile input', () => {
    const t0 = performance.now();
    for (const raw of [
      '<'.repeat(200_000),
      '<a'.repeat(100_000),
      '&#'.repeat(100_000),
      '<!--'.repeat(50_000),
      '<script>'.repeat(50_000),
      '&'.repeat(200_000),
      '<'.repeat(100_000) + '>',
    ]) {
      const out = one(raw, 500);
      expect(out).not.toMatch(/[<>]/);
    }
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('never throws on lone surrogates, huge code points or odd numeric entities', () => {
    for (const raw of [
      '\ud800',
      '\udc00x',
      '&#0;',
      '&#xD800;',
      '&#x110000;',
      '&#99999999999;',
      '&#x;',
      '&#;',
      '&#-5;',
      '&#x41;&#66;',
    ])
      expect(() => one(raw)).not.toThrow();
    expect(one('&#x41;&#66;')).toBe('AB');
    expect(one('a&#0;b')).toBe('ab');
    expect(one('a&#xD800;b')).toBe('ab');
  });
});

describe('parseFeed: JSON', () => {
  const doc = (list: unknown[]) => JSON.stringify({ items: list });
  const item = {
    id: 'a-1',
    title: 'Tide tables',
    summary: 'When the water comes in.',
    content: 'Full text of the tide tables.',
    language: 'en',
    topics: ['tides', 'harbour'],
    published: '2026-10-01T09:00:00Z',
    price_minor: 150,
  };

  it('reads the fields of an item', () => {
    expect(items(parseFeed(doc([item]), JSON_CT))).toEqual([
      {
        source_id: 'a-1',
        title: 'Tide tables',
        abstract: 'When the water comes in.',
        body: 'Full text of the tide tables.',
        language: 'en',
        topics: ['tides', 'harbour'],
        published_at: '2026-10-01T09:00:00.000Z',
        price_minor: 150,
        // POB-I1: every entry reports its link (null here: the item has none).
        link: null,
      },
    ]);
  });
  it('reads a JSON Feed item', () => {
    const jf = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      items: [
        {
          id: 'j1',
          title: 'T',
          summary: 'S',
          content_text: 'Body text',
          tags: ['x'],
          date_published: '2026-10-02T00:00:00Z',
          language: 'de',
        },
      ],
    });
    const [i] = items(parseFeed(jf, 'application/feed+json'));
    expect(i).toMatchObject({
      source_id: 'j1',
      body: 'Body text',
      topics: ['x'],
      language: 'de',
      price_minor: null,
    });
  });
  it('strips markup from every text field', () => {
    const [i] = items(
      parseFeed(
        doc([
          {
            ...item,
            title: '<b>Hi</b>',
            summary: '<script>x</script>Sum',
            content: '<p>One</p><p>Two</p>',
          },
        ]),
        JSON_CT,
      ),
    );
    expect(i).toMatchObject({ title: 'Hi', abstract: 'Sum', body: 'OneTwo' });
  });
  it('a missing or odd language becomes und, a missing date becomes null', () => {
    const [i, j] = items(
      parseFeed(
        doc([
          { ...item, language: '<x>', published: undefined },
          { ...item, id: 'a-2', language: undefined, published: 'not a date' },
        ]),
        JSON_CT,
      ),
    );
    expect([i!.language, i!.published_at, j!.language, j!.published_at]).toEqual([
      'und',
      null,
      'und',
      null,
    ]);
  });
  it('field caps: title 200, abstract 600, 8 topics of 40 characters', () => {
    const [i] = items(
      parseFeed(
        doc([
          {
            ...item,
            title: 't'.repeat(500),
            summary: 's'.repeat(900),
            topics: Array.from({ length: 12 }, (_, k) => `${String(k)}${'z'.repeat(80)}`),
          },
        ]),
        JSON_CT,
      ),
    );
    expect(i!.title).toHaveLength(200);
    expect(i!.abstract).toHaveLength(600);
    expect(i!.topics).toHaveLength(8);
    expect(i!.topics.every((t) => t.length === 40)).toBe(true);
  });
  it('skips (does not refuse the feed for) an item that is unusable', () => {
    const big = { ...item, id: 'big', content: 'b'.repeat(20_001) };
    const r = parseFeed(
      doc([
        item,
        big,
        { ...item, id: '' },
        { ...item, id: 7 },
        { ...item, id: 'nt', title: '<b></b>' },
        { ...item, id: 'nb', content: '<i></i>' },
        'str',
        null,
        5,
        [],
        { ...item, id: 'a-1' },
      ]),
      JSON_CT,
    );
    expect(r.ok && r.value.items.map((x) => x.source_id)).toEqual(['a-1']);
    expect(r.ok && r.value.skipped).toBe(10);
  });
  it('a price that is not a plain integer is null (the importer decides what that means)', () => {
    const got = items(
      parseFeed(
        doc(
          [150, 0, -1, 12.5, '100', null, Number.MAX_SAFE_INTEGER, true].map((p, k) => ({
            ...item,
            id: `p${String(k)}`,
            price_minor: p,
          })),
        ),
        JSON_CT,
      ),
    );
    expect(got.map((x) => x.price_minor)).toEqual([
      150,
      0,
      -1,
      null,
      null,
      null,
      Number.MAX_SAFE_INTEGER,
      null,
    ]);
  });
  it('accepts exactly 100 items and refuses 101', () => {
    const many = (n: number) =>
      doc(Array.from({ length: n }, (_, k) => ({ ...item, id: `i${String(k)}` })));
    expect(items(parseFeed(many(FEED_MAX_ITEMS), JSON_CT))).toHaveLength(100);
    const r = parseFeed(many(FEED_MAX_ITEMS + 1), JSON_CT);
    expect(!r.ok && r.error.code).toBe('too_many_items');
  });
  it.each([
    ['not json', 'nope', 'bad_json'],
    ['a truncated document', '{"items":[', 'bad_json'],
    ['a bare string', '"x"', 'unsupported'],
    ['a number', '5', 'unsupported'],
    ['null', 'null', 'unsupported'],
    ['no items key', '{}', 'unsupported'],
    ['items not a list', '{"items":{}}', 'unsupported'],
    ['an empty body', '', 'bad_json'],
  ])('refuses %s', (_n, text, code) => {
    const r = parseFeed(text, JSON_CT);
    expect(!r.ok && r.error.code).toBe(code);
  });
  it('a __proto__ key is just data', () => {
    const r = parseFeed(
      '{"items":[{"id":"p","title":"T","summary":"S","content":"C","__proto__":{"price_minor":1}}],"__proto__":{"items":[]}}',
      JSON_CT,
    );
    expect(r.ok && r.value.items[0]?.price_minor).toBeNull();
    expect(({} as Record<string, unknown>)['price_minor']).toBeUndefined();
  });
  it('a document nested very deeply is refused, not a stack overflow', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    expect(() => parseFeed(`{"items":${deep}}`, JSON_CT)).not.toThrow();
  });
  it('an unknown content type is unsupported', () => {
    const r = parseFeed(doc([item]), 'text/html');
    expect(!r.ok && r.error.code).toBe('unsupported');
  });
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Harbour</title>
  <entry>
    <id>urn:harbour:1</id>
    <title type="html">Ferry &lt;b&gt;times&lt;/b&gt;</title>
    <link href="https://elsewhere.invalid/never-fetched"/>
    <summary>Ferry summary.</summary>
    <content type="html"><![CDATA[<p>Ferry body</p><script>x()</script>]]></content>
    <category term="ferry"/><category term="transport"/>
    <published>2026-10-03T08:00:00Z</published>
  </entry>
  <entry>
    <id>urn:harbour:2</id><title>Second</title><summary>S2</summary><content>B2</content>
    <updated>2026-10-04T08:00:00Z</updated>
  </entry>
</feed>`;
const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Quay</title>
    <item>
      <guid isPermaLink="false">q-1</guid>
      <title>Market hall</title>
      <description>Short &amp; sweet</description>
      <content:encoded><![CDATA[<h1>Hall</h1><p>moved</p>]]></content:encoded>
      <category>markets</category><category>town</category>
      <pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe('parseFeed: Atom and RSS', () => {
  it('reads Atom entries', () => {
    const got = items(parseFeed(ATOM, 'application/atom+xml; charset=utf-8'));
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      source_id: 'urn:harbour:1',
      title: 'Ferry times',
      abstract: 'Ferry summary.',
      body: 'Ferry body',
      language: 'und',
      topics: ['ferry', 'transport'],
      published_at: '2026-10-03T08:00:00.000Z',
      price_minor: null,
      // POB-I1: the alternate link is reported (here the entry's link is the one of the ATOM fixture).
      link: got[0]!.link,
    });
    expect(got[1]!.published_at).toBe('2026-10-04T08:00:00.000Z');
  });
  it('reads RSS items', () => {
    const [i] = items(parseFeed(RSS, 'application/rss+xml'));
    expect(i).toMatchObject({
      source_id: 'q-1',
      title: 'Market hall',
      abstract: 'Short & sweet',
      body: 'Hallmoved',
      topics: ['markets', 'town'],
      published_at: '2026-10-05T10:00:00.000Z',
    });
  });
  it('the same XML is read for application/xml and text/xml', () => {
    expect(items(parseFeed(RSS, 'application/xml'))).toHaveLength(1);
    expect(items(parseFeed(RSS, 'text/xml'))).toHaveLength(1);
  });
  // POB-I1 changes this test of FEED ("a link in an entry is never part of the result"): the web import needs
  // the entry's own page address, so it is now reported in the `link` field and nowhere else. Reporting is
  // still not reading: nothing in this module can reach a link, and the text fields never hold it.
  it('a link in an entry is reported in the link field only, never in the text fields', () => {
    const got = items(parseFeed(ATOM, 'application/atom+xml'));
    const text = JSON.stringify(got.map(({ link: _link, ...rest }) => rest));
    expect(text).not.toContain('elsewhere.invalid');
    expect(got.some((i) => i.link !== null && i.link.includes('elsewhere.invalid'))).toBe(true);
  });
  it.each([
    [
      'a doctype',
      '<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "y">]><feed><entry><id>1</id></entry></feed>',
    ],
    ['a doctype without a subset', '<!DOCTYPE feed><feed/>'],
    ['an entity declaration', '<feed><!ENTITY x SYSTEM "file:///etc/passwd"></feed>'],
    [
      'the billion laughs',
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><feed><entry><id>&lol2;</id></entry></feed>',
    ],
    ['a stylesheet instruction', '<?xml-stylesheet href="x.xsl"?><feed/>'],
    ['a processing instruction inside', '<feed><?php echo 1 ?></feed>'],
    ['an unclosed element', '<feed><entry><id>1</id></feed>'],
    ['mismatched tags', '<feed><entry></feed></entry>'],
    ['text before the root', 'hello<feed/>'],
    ['two roots', '<feed/><feed/>'],
    ['an empty body', ''],
    ['an unterminated tag', '<feed><entry'],
    ['an unterminated CDATA', '<feed><entry><id><![CDATA[x</id></entry></feed>'],
    ['an unterminated comment', '<feed><!-- x </feed>'],
    ['a bad attribute', '<feed a=b></feed>'],
    ['a duplicate attribute', '<feed a="1" a="2"></feed>'],
  ])('refuses %s', (_n, text) => {
    const r = parseFeed(text, 'application/xml');
    expect(!r.ok && r.error.code).toBe('bad_xml');
  });
  it('a root that is neither feed nor rss is unsupported', () => {
    const r = parseFeed('<html><body>hi</body></html>', 'application/xml');
    expect(!r.ok && r.error.code).toBe('unsupported');
  });
  it('depth over 32 is refused without recursion limits being hit', () => {
    const deep = '<feed>' + '<a>'.repeat(40) + 'x' + '</a>'.repeat(40) + '</feed>';
    const r = parseFeed(deep, 'application/atom+xml');
    expect(!r.ok && r.error.code).toBe('bad_xml');
    const huge = '<feed>' + '<a>'.repeat(200_000);
    expect(() => parseFeed(huge, 'application/atom+xml')).not.toThrow();
  });
  it('more than 20000 elements is refused', () => {
    const many = '<feed>' + '<a/>'.repeat(20_001) + '</feed>';
    const r = parseFeed(many, 'application/atom+xml');
    expect(!r.ok && r.error.code).toBe('bad_xml');
  });
  it('refuses 101 entries', () => {
    const e = (k: number) =>
      `<entry><id>i${String(k)}</id><title>T</title><summary>S</summary><content>C</content></entry>`;
    const r = parseFeed(
      `<feed>${Array.from({ length: 101 }, (_, k) => e(k)).join('')}</feed>`,
      'application/atom+xml',
    );
    expect(!r.ok && r.error.code).toBe('too_many_items');
  });
  it('character references in text are decoded once', () => {
    const [i] = items(
      parseFeed(
        '<feed><entry><id>1</id><title>A &amp;lt; B</title><summary>S</summary><content>C</content></entry></feed>',
        'application/atom+xml',
      ),
    );
    expect(i!.title).toBe('A &lt; B');
  });
});

// POB-I1 (D-089): the web import keeps an entry that has only a link (its own page is read later), and
// every entry reports its link. The default stays as FEED had it: an entry without text is skipped.
describe('links and entries without text (web import)', () => {
  const rss = (item: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><language>en</language>${item}</channel></rss>`;
  const XML_CT = 'application/rss+xml';

  it('RSS: the link of an item is reported, and the guid is the id', () => {
    const r = parseFeed(
      rss(
        '<item><guid>g1</guid><title>T</title><link>https://shop.pub-one.invalid/a/1</link><description>Text</description></item>',
      ),
      XML_CT,
    );
    expect(r.ok && r.value.items[0]!.link).toBe('https://shop.pub-one.invalid/a/1');
  });

  it('by default an item with only a link is skipped, as before', () => {
    const r = parseFeed(
      rss('<item><guid>g1</guid><title>T</title><link>https://x.invalid/a</link></item>'),
      XML_CT,
    );
    expect(r.ok && r.value.items).toEqual([]);
    expect(r.ok && r.value.skipped).toBe(1);
  });

  it('with keepBodyless the item stays: empty body, the link kept, summary taken from the title', () => {
    const r = parseFeed(
      rss('<item><guid>g1</guid><title>Quay walk</title><link>https://x.invalid/a</link></item>'),
      XML_CT,
      { keepBodyless: true },
    );
    expect(r.ok && r.value.items).toEqual([
      expect.objectContaining({
        source_id: 'g1',
        title: 'Quay walk',
        abstract: 'Quay walk',
        body: '',
        link: 'https://x.invalid/a',
      }),
    ]);
  });

  it('with keepBodyless an item with neither text nor link is still skipped', () => {
    const r = parseFeed(rss('<item><guid>g1</guid><title>Quay walk</title></item>'), XML_CT, {
      keepBodyless: true,
    });
    expect(r.ok && r.value.items).toEqual([]);
    expect(r.ok && r.value.skipped).toBe(1);
  });

  it('with keepBodyless an item with no guid takes its link as the id', () => {
    const r = parseFeed(
      rss('<item><title>Quay walk</title><link>https://x.invalid/a</link></item>'),
      XML_CT,
      { keepBodyless: true },
    );
    expect(r.ok && r.value.items[0]!.source_id).toBe('https://x.invalid/a');
  });

  it('Atom: the alternate link is reported (rel alternate or no rel), other links are not', () => {
    const atom =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><title>T</title><summary>S</summary><content>Body</content>' +
      '<link rel="enclosure" href="https://x.invalid/file.pdf"/><link rel="alternate" href="https://x.invalid/page"/></entry>' +
      '<entry><id>2</id><title>U</title><content>Body</content><link href="https://x.invalid/other"/></entry></feed>';
    const r = parseFeed(atom, 'application/atom+xml');
    expect(r.ok && r.value.items.map((i) => i.link)).toEqual([
      'https://x.invalid/page',
      'https://x.invalid/other',
    ]);
  });

  it('JSON feed: the url field is the link', () => {
    const r = parseFeed(
      JSON.stringify({
        items: [{ id: '1', title: 'T', content_text: 'Body', url: 'https://x.invalid/a' }],
      }),
      'application/feed+json',
    );
    expect(r.ok && r.value.items[0]!.link).toBe('https://x.invalid/a');
  });

  it('a link is text of at most 2048 visible characters or none; nothing else is kept', () => {
    for (const bad of [
      'javascript:alert(1)',
      'a b',
      `https://x.invalid/${'a'.repeat(2100)}`,
      '<b>x</b>',
    ]) {
      const r = parseFeed(
        JSON.stringify({ items: [{ id: '1', title: 'T', content_text: 'Body', url: bad }] }),
        'application/feed+json',
      );
      expect(r.ok && r.value.items[0]!.link).toBeNull();
    }
  });
});
