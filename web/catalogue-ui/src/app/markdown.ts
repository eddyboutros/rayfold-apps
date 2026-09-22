/**
 * The little of Markdown the knowledge base uses — headings, paragraphs, lists, tables, emphasis and code — turned
 * into HTML. Everything is escaped first; the markup is the only HTML that reaches the page.
 */
export function render(markdown: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  const out: string[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      // a list item continues onto indented lines beneath it
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i] ?? "") || /^\s*\d+\.\s+/.test(lines[i] ?? "") || /^\s{2,}\S/.test(lines[i] ?? ""))) {
        const l = lines[i] ?? "";
        if (/^\s{2,}\S/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else items.push(l.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i] ?? "")) rows.push(lines[i] ?? ""), i++;
      const cells = (r: string) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [head, ...rest] = rows;
      const body = rest.filter((r) => !/^\|\s*-/.test(r));
      out.push(
        `<table><thead><tr>${cells(head ?? "").map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }
    // a paragraph runs until a blank line or something that is not prose
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i] ?? "")) para.push((lines[i] ?? "").trim()), i++;
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
