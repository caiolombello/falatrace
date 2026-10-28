/**
 * Presentation-only Markdown for Qt. Bun 1.4 parses the structure; only these callbacks
 * produce tags. Raw HTML is escaped, images become their alt text and external links
 * become text. The only active URLs are checked, numbered recording citations.
 * https://bun.com/docs/runtime/markdown
 */
export const renderAssistantMarkdown = (text: string, citations: ReadonlyArray<{ n: number }> = []): string => {
  const allowed = new Set(citations.map((citation) => citation.n));
  const html = Bun.markdown.render(text, {
    text: (value) => Bun.escapeHTML(value),
    html: (value) => Bun.escapeHTML(value),
    paragraph: (value) => `<p style="margin-top:0;margin-bottom:8px">${value}</p>`,
    heading: (value, meta) => {
      const level = Math.max(1, Math.min(6, meta.level));
      const size = level <= 2 ? 18 : level === 3 ? 16 : 14;
      return `<h${level} style="font-size:${size}px;margin-top:8px;margin-bottom:4px">${value}</h${level}>`;
    },
    strong: (value) => `<b>${value}</b>`,
    emphasis: (value) => `<i>${value}</i>`,
    strikethrough: (value) => `<s>${value}</s>`,
    // Bun already HTML-escapes code children, independently of the text callback.
    code: (value) => `<pre style="margin-top:4px;margin-bottom:8px;white-space:pre-wrap">${value}</pre>`,
    codespan: (value) => `<code>${value}</code>`,
    blockquote: (value) => `<blockquote>${value}</blockquote>`,
    list: (value, meta) => meta.ordered ? `<ol start="${Math.max(1, Math.trunc(meta.start ?? 1))}">${value}</ol>` : `<ul>${value}</ul>`,
    listItem: (value, meta) => `<li>${typeof meta.checked === "boolean" ? (meta.checked ? "☑ " : "☐ ") : ""}${value}</li>`,
    hr: () => "<hr>",
    table: (value) => `<table width="100%" cellpadding="3" cellspacing="0">${value}</table>`,
    thead: (value) => value,
    tbody: (value) => value,
    tr: (value) => `<tr>${value}</tr>`,
    th: (value) => `<th>${value}</th>`,
    td: (value) => `<td>${value}</td>`,
    image: (value) => value,
    link: (value) => value
  });
  // Bun may split a marker across text callbacks. Link after rendering, skipping code;
  // every tag/attribute above is ours, so untrusted input cannot inject a URL here.
  return html.replace(/(<pre\b[^>]*>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)|\[(\d{1,6})\]/g, (marker, code: string | undefined, number: string) =>
    code || !allowed.has(Number(number)) ? marker : `<a href="citation:${Number(number)}">${marker}</a>`);
};
