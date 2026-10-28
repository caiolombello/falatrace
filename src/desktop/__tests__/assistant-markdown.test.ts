import { describe, expect, test } from "bun:test";
import { renderAssistantMarkdown } from "../assistant-markdown";

describe("assistant Markdown presentation", () => {
  test("formats structure and inline styles while linking only checked citations", () => {
    const html = renderAssistantMarkdown("## Compromissos\n\n- **Enviar proposta** [1]\n- *Revisar* `plano` [9]\n\n> Até sexta.\n\n3. Primeiro\n4. Segundo", [{ n: 1 }]);
    expect(html).toContain("<h2 ");
    expect(html).toContain("<b>Enviar proposta</b>");
    expect(html).toContain("<i>Revisar</i>");
    expect(html).toContain("<code>plano</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<a href="citation:1">[1]</a>');
    expect(html).not.toContain("citation:9");
  });

  test("keeps code blocks, blank lines and angle brackets literal, without citation links inside code", () => {
    const html = renderAssistantMarkdown("```html\n<div>[1]</div>\n\n<img src=\"file:///private\">\n```\n\n`[1]`", [{ n: 1 }]);
    expect(html).toContain("&lt;div&gt;[1]&lt;/div&gt;\n\n");
    expect(html).not.toContain("&amp;lt;div");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<img");
  });

  test("external and local resources remain inert in HTML, Markdown images, reference images and links", () => {
    for (const source of [
      '<img src="https://invalid.test/pixel"><iframe src="file:///private"></iframe>',
      "![remote](https://invalid.test/pixel) ![local](file:///private.png)",
      "![reference][image]\n\n[image]: https://invalid.test/pixel",
      "[click](javascript:alert(1)) [file](file:///private) [web](https://invalid.test)",
      '<style>p {background:url(https://invalid.test/pixel)}</style><script>bad()</script>',
      "![<img src=x onerror=bad()>](x) &lt;img src=x&gt;",
      '```"><img src=x>\n</pre><img src=x>\n```'
    ]) {
      const html = renderAssistantMarkdown(source, [{ n: 1 }]);
      expect(html).not.toMatch(/<(?:img|iframe|script|style)\b/i);
      expect(html).not.toMatch(/<[^>]*\b(?:src|href)\s*=/i);
    }
  });

  test("partial Markdown stays safe while a response streams", () => {
    const text = '## Ação\n\n**Enviar** [1]\n\n<img src="https://invalid.test/x">';
    for (let end = 0; end <= text.length; end++) {
      const html = renderAssistantMarkdown(text.slice(0, end), [{ n: 1 }]);
      expect(html).not.toMatch(/<img\b|href="https:/i);
    }
  });

  test("renders tables and task lists as passive document content", () => {
    const html = renderAssistantMarkdown("| Ação | Prazo |\n|---|---|\n| Enviar | sexta |\n\n- [ ] Aberta\n- [x] Feita");
    expect(html).toContain("<table ");
    expect(html).toContain("<th>Ação</th>");
    expect(html).toContain("<td>sexta</td>");
    expect(html).toContain("☐ ");
    expect(html).toContain("☑ ");
    expect(html).not.toContain("<input");
  });
});
