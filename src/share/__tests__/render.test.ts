import { describe, expect, test } from "bun:test";
import {
  SHARE_KNOWN_ERRORS,
  SHARE_KNOWN_WARNINGS,
  SHARE_MESSAGES,
  ShareError,
  assertRenderedShare,
  escapeInline,
  formatLocalDateTime,
  parseInlineMarkdown,
  readFrontmatterValue,
  renderShare,
  renderShareMarkdown,
  renderTextShare,
  validateShareNote,
  yamlString,
  type ShareNote
} from "../index";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

const note = (overrides: Partial<ShareNote> = {}): ShareNote => ({
  jobId: JOB,
  title: "Kickoff ACME",
  date: "2026-10-25T14:00:00.000Z",
  people: ["Ana Souza", "Bruno Lima"],
  client: "ACME",
  template: "planning",
  overview: "We agreed the migration plan.\n\nThe pilot starts next week.",
  decisions: ["Use blue/green deploys"],
  actions: [
    { text: "Send the proposal", owner: "Ana", dueDate: "2026-10-30", done: false },
    { text: "Book the room", owner: "", dueDate: "", done: true }
  ],
  notes: ["# Agenda", "- [ ] check budget", "[x] done item", "- plain bullet", "free text"],
  transcript: [
    { at: "00:05", speaker: "Ana", text: "Hello everyone" },
    { at: "01:02:03", text: "No speaker here" }
  ],
  link: `falatrace://recording/${JOB}`,
  ...overrides
});

const options = { frontmatter: true, language: "pt-BR" as const, include: "summary" as const, timeZone: "UTC" };

const parseFrontmatter = (document: string): Record<string, unknown> => {
  expect(document.startsWith("---\n")).toBe(true);
  const end = document.indexOf("\n---\n", 4);
  expect(end).toBeGreaterThan(0);
  return (Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML.parse(document.slice(4, end)) as Record<string, unknown>;
};

const expectShareError = (action: () => unknown, message: string): void => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ShareError);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error("expected a ShareError");
};

describe("renderShare", () => {
  test("summary profile: title, meta line, overview, decisions, checklist, link; no notes or transcript", () => {
    const share = renderShare(note(), options);
    const body = share.body;
    expect(body.startsWith("# Kickoff ACME\n\n**Data:** 2026-10-25 14:00 · **Participantes:** Ana Souza, Bruno Lima · **Cliente:** ACME")).toBe(true);
    expect(body).toContain("## Resumo\n\nWe agreed the migration plan.\n\nThe pilot starts next week.");
    expect(body).toContain("## Decisões\n\n- Use blue/green deploys");
    expect(body).toContain("## Ações\n\n- [ ] Send the proposal (Ana · até 2026-10-30)\n- [x] Book the room");
    expect(body).not.toContain("## Notas");
    expect(body).not.toContain("## Transcrição");
    expect(body.trimEnd().endsWith(`---\n\n[Abrir no FalaTrace](falatrace://recording/${JOB})`)).toBe(true);
    expect(share.markdown).toBe(share.document);
    expect(share.document.endsWith(share.body)).toBe(true);
    expect(share.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("summary+notes keeps the raw notes; full adds the transcript", () => {
    const withNotes = renderShare(note(), { ...options, include: "summary+notes" }).body;
    expect(withNotes).toContain("## Notas\n\n### Agenda\n- [ ] check budget\n- [x] done item\n- plain bullet\n- free text");
    expect(withNotes).not.toContain("## Transcrição");
    const full = renderShare(note(), { ...options, include: "full" }).body;
    expect(full).toContain("## Transcrição\n\n**[00:05] Ana:** Hello everyone\n\n**[01:02:03]** No speaker here");
  });

  test("labels follow the language", () => {
    const en = renderShare(note(), { ...options, language: "en" }).body;
    expect(en).toContain("**Date:**");
    expect(en).toContain("## Action items");
    expect(en).toContain("(Ana · due 2026-10-30)");
    expect(en).toContain("[Open in FalaTrace]");
    const es = renderShare(note(), { ...options, language: "es" }).body;
    expect(es).toContain("## Resumen");
    expect(es).toContain("[Abrir en FalaTrace]");
  });

  test("template sections replace the decisions list; the action checklist stays", () => {
    const body = renderShare(note({
      sections: [
        { heading: "Objetivos", items: [{ text: "Migrate billing", origin: "user" }, { text: "Cut costs", origin: "ai" }] },
        { heading: "Vazio", items: [] }
      ]
    }), options).body;
    expect(body).toContain("## Objetivos\n\n- Migrate billing\n- Cut costs");
    expect(body).not.toContain("## Vazio");
    expect(body).not.toContain("## Decisões");
    expect(body).toContain("## Ações");
  });

  test("frontmatter is JSON-quoted YAML with the expected keys", () => {
    const share = renderShare(note(), options);
    const data = parseFrontmatter(share.document);
    expect(data).toEqual({
      title: "Kickoff ACME",
      falatrace_snapshot: share.snapshot,
      date: "2026-10-25T14:00:00.000Z",
      falatrace_job: JOB,
      participants: ["Ana Souza", "Bruno Lima"],
      client: "ACME",
      template: "planning",
      tags: ["falatrace"],
      source: `falatrace://recording/${JOB}`
    });
    expect(renderShareMarkdown(note(), { ...options, frontmatter: false }).startsWith("# Kickoff ACME")).toBe(true);
  });

  test("frontmatter resists injection through titles, names and clients", () => {
    const hostile = 'Q3 "review": ok\n---\nevil: true\r\n# not a heading \u2028 tags: [x]';
    const share = renderShare(note({ title: hostile, people: ['Ana "the boss"', "x\n---\ny: 1"], client: "a: b # c" }), options);
    const data = parseFrontmatter(share.document);
    expect(Object.keys(data).sort()).toEqual(["client", "date", "falatrace_job", "falatrace_snapshot", "participants", "source", "tags", "template", "title"]);
    expect(data.title).toBe('Q3 "review": ok --- evil: true # not a heading tags: [x]');
    expect(data.participants).toEqual(['Ana "the boss"', "x --- y: 1"]);
    expect(data.client).toBe("a: b # c");
    expect(data.tags).toEqual(["falatrace"]);
    // Exactly one frontmatter block: the second "---" line closes it, and nothing else in the
    // file is a bare "---" line except the divider before the link.
    const lines = share.document.split("\n");
    expect(lines.filter((line) => line === "---").length).toBe(3);
    expect(share.body.split("\n")[0]).toBe('# Q3 "review": ok --- evil: true # not a heading tags: [x]');
  });

  test("yamlString strips control and separator characters and stays valid YAML", () => {
    for (const value of ["plain", "quote \" and \\ backslash", "line\nbreak\ttab", "sep\u2028par\u2029bom\uFEFF", "\u0085nel", "lone \ud800 surrogate", "a: b", "- item", "&anchor *alias !tag %dir @at `tick`"]) {
      const quoted = yamlString(value);
      expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true);
      expect(/[\n\r\u2028\u2029\u0085]/.test(quoted)).toBe(false);
      const parsed = (Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML.parse(`k: ${quoted}`) as { k: string };
      expect(typeof parsed.k).toBe("string");
      expect(/[\p{Cc}\u2028\u2029]/u.test(parsed.k)).toBe(false);
    }
  });

  test("untrusted text cannot start Markdown blocks, open HTML or load remote images", () => {
    const body = renderShare(note({
      overview: "# fake heading\n\n- fake list\n\n<img src=x onerror=alert(1)>\n\n![pixel](https://tracker.example/p.png)\n\n1. fake ordered\n\n---\n\n| table |",
      decisions: ["[x] looks done", "## heading in list"],
      actions: [{ text: "- [x] nested fake", owner: "<b>Ana</b>", dueDate: "", done: false }],
      notes: ["<script>alert(1)</script>", "# ![img](http://x/y.png)"]
    }), { ...options, include: "summary+notes" }).body;
    expect(body).toContain("\\# fake heading");
    expect(body).toContain("\\- fake list");
    expect(body).toContain("\\<img src=x onerror=alert(1)>");
    expect(body).toContain("\\![pixel](https://tracker.example/p.png)");
    expect(body).toContain("1\\. fake ordered");
    expect(body).toContain("\\---");
    expect(body).toContain("\\| table |");
    expect(body).toContain("- \\[x] looks done");
    expect(body).toContain("- \\## heading in list");
    expect(body).toContain("- [ ] \\- [x] nested fake (\\<b>Ana\\</b>)");
    expect(body).toContain("- \\<script>alert(1)\\</script>");
    expect(body).toContain("### \\![img](http://x/y.png)");
    expect(body).not.toMatch(/(^|[^\\])!\[/m);
    expect(body).not.toMatch(/(^|[^\\])<[a-z/]/im);
  });

  test("line breaks inside items cannot forge list entries or checkboxes", () => {
    const body = renderShare(note({ actions: [{ text: "pay\n- [x] fake done", owner: "", dueDate: "", done: false }], decisions: [] }), options).body;
    expect(body).toContain("- [ ] pay - [x] fake done");
    expect(body.split("\n").filter((line) => line.startsWith("- [x]")).length).toBe(0);
  });

  test("credentials and e-mails in meeting text are redacted", () => {
    const body = renderShare(note({ overview: "Key sk-abcdefghijklmnopqrstuvwxyz and mail ana@example.com" }), options).body;
    expect(body).toContain("[credencial omitida]");
    expect(body).toContain("[e-mail omitido]");
    expect(body).not.toContain("ana@example.com");
  });

  test("snapshot is stable for equal content and changes with any visible change", () => {
    const first = renderShare(note(), options);
    expect(renderShare(note(), options).snapshot).toBe(first.snapshot);
    expect(renderShare(note(), { ...options, frontmatter: false }).snapshot).toBe(first.snapshot);
    expect(renderShare(note({ title: "Other" }), options).snapshot).not.toBe(first.snapshot);
    expect(renderShare(note({ client: "Other" }), options).snapshot).not.toBe(first.snapshot);
    expect(renderShare(note(), { ...options, include: "full" }).snapshot).not.toBe(first.snapshot);
    expect(renderShare(note(), { ...options, language: "en" }).snapshot).not.toBe(first.snapshot);
    expect(renderShare(note(), { ...options, timeZone: "America/Sao_Paulo" }).snapshot).not.toBe(first.snapshot);
  });

  test("dates follow the time zone", () => {
    expect(formatLocalDateTime("2026-10-25T14:00:00Z", "America/Sao_Paulo")).toBe("2026-10-25 11:00");
    expect(formatLocalDateTime("2026-10-25T23:30:00Z", "Asia/Tokyo")).toBe("2026-10-26 08:30");
    expect(formatLocalDateTime("2026-10-25T00:00:00Z", "UTC")).toBe("2026-10-25 00:00");
    expectShareError(() => formatLocalDateTime("2026-10-25T00:00:00Z", "Not/AZone"), SHARE_MESSAGES.invalidOptions);
  });

  test("an empty title falls back to a localized label", () => {
    const share = renderShare(note({ title: "\n\t " }), { ...options, language: "en" });
    expect(share.title).toBe("Untitled meeting");
    expect(share.body.startsWith("# Untitled meeting")).toBe(true);
  });

  test("lone surrogates are dropped from meeting text", () => {
    const share = renderShare(note({ title: "Bad \ud800 title", overview: "x \udc00 y" }), options);
    expect(share.title).toBe("Bad title");
    expect(/[\ud800-\udfff]/.test(share.body.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))).toBe(false);
  });

  test("cutting text to its limit never leaves half an emoji", () => {
    // 299 + a surrogate pair: the 300-character title limit falls between its two halves.
    const cut = `${"x".repeat(299)}😀`;
    const share = renderShare(note({ title: cut, overview: `${"y".repeat(19_999)}😀`, people: [`${"p".repeat(119)}😀`] }), options);
    for (const text of [share.title, share.body, share.document]) expect(/\p{Cs}/u.test(text)).toBe(false);
    expect(share.title).toBe("x".repeat(299));
    const text = renderTextShare({ title: cut, text: "ok", language: "en", date: "2026-10-25T10:00:00Z" });
    expect(/\p{Cs}/u.test(text.document)).toBe(false);
  });

  test("Obsidian plugins cannot run code written in meeting text", () => {
    const templater = "<%* app.vault.adapter.remove('x') %>";
    const dataview = "`$= require('child_process').exec('id')`";
    const share = renderShare(note({
      title: `Weekly ${templater}`,
      people: [`Ana ${templater}`],
      overview: `Summary ${dataview} and ${templater}`,
      decisions: [`Decide ${dataview}`],
      actions: [{ text: `Act ${dataview}`, owner: templater, dueDate: "", done: false }],
      notes: [`note ${dataview}`, "```dataviewjs", templater],
      transcript: [{ at: "00:01", speaker: `Bob ${templater}`, text: `said ${dataview}` }]
    }), { ...options, include: "full" });
    // Templater looks for "<%" anywhere in the file, frontmatter included.
    expect(share.document).not.toContain("<%");
    // Dataview runs code spans starting with "$=": no unescaped backtick may open one.
    expect(share.body).not.toMatch(/(^|[^\\])`/m);
    expect(share.body).toContain("<\\%* app.vault.adapter.remove('x') %>");
    expect(share.body).toContain("\\`$= require('child_process').exec('id')\\`");
    const data = parseFrontmatter(share.document);
    expect(data.title).toBe(`Weekly ${templater}`);
    expect(data.participants).toEqual([`Ana ${templater}`]);
    expect(readFrontmatterValue(share.document, "title")).toBe(`Weekly ${templater}`);
    // Destinations that read the Markdown get the original characters back.
    expect(parseInlineMarkdown(share.body.split("\n")[0].slice(2)).map((segment) => segment.text).join("")).toBe(`Weekly ${templater}`);
  });

  test("a date without a time keeps its day in every zone", () => {
    expect(formatLocalDateTime("2026-10-25", "America/Sao_Paulo")).toBe("2026-10-25 00:00");
    expect(formatLocalDateTime("2026-10-25", "Asia/Tokyo")).toBe("2026-10-25 00:00");
    expectShareError(() => formatLocalDateTime("2026-10-25", "Not/AZone"), SHARE_MESSAGES.invalidOptions);
    const body = renderShare(note({ date: "2026-10-25" }), { ...options, timeZone: "America/Sao_Paulo" }).body;
    expect(body).toContain("**Data:** 2026-10-25 00:00");
  });

  test("an oversized raw transcript is refused before it is processed", () => {
    const transcript = Array.from({ length: 600 }, () => ({ at: "00:01", text: "z".repeat(4_000) }));
    expectShareError(() => validateShareNote({ ...note(), transcript }), SHARE_MESSAGES.tooLarge);
  });

  test("full transcripts past the size limit are refused", () => {
    const transcript = Array.from({ length: 300 }, (_, index) => ({ at: "00:01", text: `${"x".repeat(3990)} ${index}` }));
    expectShareError(() => renderShare(note({ transcript }), { ...options, include: "full" }), SHARE_MESSAGES.tooLarge);
    expect(() => renderShare(note({ transcript }), options)).not.toThrow();
  });
});

describe("validateShareNote", () => {
  test("rebuilds a valid note and drops empty optional values", () => {
    const valid = validateShareNote({ ...note(), client: "  ", people: ["Ana", "  "] });
    expect(valid.client).toBeUndefined();
    expect(valid.people).toEqual(["Ana"]);
  });

  const invalidCases: Array<[string, unknown]> = [
    ["not an object", "note"],
    ["unknown field", { ...note(), extra: 1 }],
    ["bad job id", { ...note(), jobId: "../../etc", link: "falatrace://recording/../../etc" }],
    ["link for another job", { ...note(), link: "falatrace://recording/11111111-1111-4111-8111-111111111111" }],
    ["link with another scheme", { ...note(), link: `https://evil.example/${JOB}` }],
    ["bad date", { ...note(), date: "yesterday" }],
    ["date with garbage", { ...note(), date: "2026-10-25T10:00:00Z; rm -rf" }],
    ["people not an array", { ...note(), people: "Ana" }],
    ["too many people", { ...note(), people: Array.from({ length: 101 }, () => "x") }],
    ["action without done", { ...note(), actions: [{ text: "x", owner: "", dueDate: "" }] }],
    ["action with extra field", { ...note(), actions: [{ text: "x", owner: "", dueDate: "", done: false, url: "x" }] }],
    ["empty action text", { ...note(), actions: [{ text: " ", owner: "", dueDate: "", done: false }] }],
    ["bad origin", { ...note(), sections: [{ heading: "H", items: [{ text: "x", origin: "model" }] }] }],
    ["empty heading", { ...note(), sections: [{ heading: "", items: [] }] }],
    ["bad transcript time", { ...note(), transcript: [{ at: "1:2", text: "x" }] }],
    ["bad template id", { ...note(), template: "../x" }],
    ["number title", { ...note(), title: 5 }],
    ["huge overview", { ...note(), overview: "x".repeat(50_000) }]
  ];
  for (const [name, value] of invalidCases) {
    test(`refuses ${name}`, () => expectShareError(() => validateShareNote(value), SHARE_MESSAGES.invalidNote));
  }

  test("refuses bad render options", () => {
    expectShareError(() => renderShare(note(), { ...options, include: "everything" as never }), SHARE_MESSAGES.invalidOptions);
    expectShareError(() => renderShare(note(), { ...options, language: "fr" as never }), SHARE_MESSAGES.invalidOptions);
    expectShareError(() => renderShare(note(), { ...options, extra: true } as never), SHARE_MESSAGES.invalidOptions);
  });
});

describe("renderTextShare", () => {
  test("keeps the assistant's Markdown structure and adds frontmatter on request", () => {
    const share = renderTextShare({
      title: "Follow-up",
      text: "Subject: Next steps\r\n\r\n- item one\n  - nested\n\n\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      jobId: JOB,
      recipeId: "follow-up-email",
      language: "en",
      frontmatter: true,
      date: "2026-10-25T10:00:00Z"
    });
    expect(share.kind).toBe("text");
    expect(share.body).toContain("Subject: Next steps\n\n- item one\n  - nested\n\n| a | b |");
    expect(share.body).toContain(`[Open in FalaTrace](falatrace://recording/${JOB})`);
    const data = parseFrontmatter(share.markdown);
    expect(data.falatrace_recipe).toBe("follow-up-email");
    expect(data.falatrace_job).toBe(JOB);
  });

  test("library results have no job link; remote images and HTML are neutralised", () => {
    const share = renderTextShare({ title: "Promises", text: "![x](https://t.example/p.png) <iframe src=x>", language: "pt-BR" }, () => new Date("2026-10-25T00:00:00Z"));
    expect(share.jobId).toBeUndefined();
    expect(share.date).toBe("2026-10-25T00:00:00.000Z");
    expect(share.body).not.toContain("falatrace://");
    expect(share.body).toContain("\\![x](https://t.example/p.png) \\<iframe src=x>");
    expect(share.markdown).toBe(share.body);
  });

  test("keeps code, but nothing an Obsidian plugin would execute", () => {
    const share = renderTextShare({
      title: "Result",
      text: [
        "```dataviewjs", "dv.paragraph(require('fs').readdirSync('/'))", "```",
        "~~~ js-engine", "return 1", "~~~",
        "```Python title=x", "print(1)", "```",
        "Inline `$= dv.current()` and ` $=x` and `plain code`",
        "```a``` b is inline code",
        "Templater <%* tR += 'x' %> and <% tp.file.title %>"
      ].join("\n"),
      language: "en",
      frontmatter: true,
      date: "2026-10-25T10:00:00Z"
    });
    const lines = share.body.split("\n");
    expect(lines).toContain("```");
    expect(lines).toContain("~~~");
    expect(lines).toContain("```python");
    expect(share.body).not.toMatch(/dataviewjs|js-engine/);
    expect(share.body).toContain("dv.paragraph(require('fs').readdirSync('/'))");
    expect(share.body).toContain("Inline `\\$= dv.current()` and ` \\$=x` and `plain code`");
    expect(share.body).not.toMatch(/`[ \t]*\$=/);
    expect(lines).toContain("```a``` b is inline code");
    expect(share.document).not.toContain("<%");
    expect(share.body).toContain("Templater <\\%* tR += 'x' %> and <\\% tp.file.title %>");
  });

  test("refuses invalid input", () => {
    expectShareError(() => renderTextShare({ title: "x", text: "", language: "en" }), SHARE_MESSAGES.invalidNote);
    expectShareError(() => renderTextShare({ title: "x", text: "ok", language: "en", jobId: "nope" }), SHARE_MESSAGES.invalidNote);
    expectShareError(() => renderTextShare({ title: "x", text: "ok", language: "en", recipeId: "../x" }), SHARE_MESSAGES.invalidNote);
    expectShareError(() => renderTextShare({ title: "x", text: "y".repeat(200_001), language: "en" }), SHARE_MESSAGES.tooLarge);
  });
});

describe("helpers", () => {
  test("assertRenderedShare detects tampering", () => {
    const share = renderShare(note(), options);
    expect(assertRenderedShare(share)).toBe(share);
    expectShareError(() => assertRenderedShare({ ...share, markdown: `${share.markdown}x` }), SHARE_MESSAGES.invalidNote);
    expectShareError(() => assertRenderedShare({ ...share, body: "other" }), SHARE_MESSAGES.invalidNote);
    expectShareError(() => assertRenderedShare({ ...share, jobId: "x" }), SHARE_MESSAGES.invalidNote);
    expectShareError(() => assertRenderedShare({ ...share, title: "a\nb" }), SHARE_MESSAGES.invalidNote);
    expectShareError(() => assertRenderedShare(null), SHARE_MESSAGES.invalidNote);
  });

  test("readFrontmatterValue reads only the leading block", () => {
    const text = '---\ntitle: "x"\nfalatrace_job: "abc"\nplain: value\n---\nfalatrace_snapshot: "late"\n';
    expect(readFrontmatterValue(text, "falatrace_job")).toBe("abc");
    expect(readFrontmatterValue(text, "plain")).toBe("value");
    expect(readFrontmatterValue(text, "falatrace_snapshot")).toBeUndefined();
    expect(readFrontmatterValue("no frontmatter", "title")).toBeUndefined();
    expect(readFrontmatterValue('---\ntitle: "broken\n---\n', "title")).toBeUndefined();
  });

  test("parseInlineMarkdown handles bold, links and escapes", () => {
    expect(parseInlineMarkdown("a **b** \\*c [d](https://e.example/f) [g](falatrace://recording/x)")).toEqual([
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " *c ", bold: false },
      { text: "d", bold: false, url: "https://e.example/f" },
      { text: " ", bold: false },
      { text: "g: falatrace://recording/x", bold: false }
    ]);
  });

  test("escapeInline only touches HTML openers, images, code spans and Templater tags", () => {
    expect(escapeInline("a < b and <tag> ![i](u) [l](u)")).toBe("a < b and \\<tag> \\![i](u) [l](u)");
    expect(escapeInline("`code` <% x %>")).toBe("\\`code\\` <\\% x %>");
  });

  test("yamlString never writes a Templater opener", () => {
    const quoted = yamlString("a <%* x %> b");
    expect(quoted).not.toContain("<%");
    expect((Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML.parse(`k: ${quoted}`)).toEqual({ k: "a <%* x %> b" });
    expect(JSON.parse(quoted)).toBe("a <%* x %> b");
  });

  test("known messages are unique Portuguese strings", () => {
    expect(new Set(SHARE_KNOWN_ERRORS).size).toBe(SHARE_KNOWN_ERRORS.length);
    expect(SHARE_KNOWN_WARNINGS.length).toBeGreaterThan(0);
    for (const message of [...SHARE_KNOWN_ERRORS, ...SHARE_KNOWN_WARNINGS]) expect(message).toMatch(/[.…]$/);
  });
});
