/**
 * The little of Markdown the help pages use: headings, paragraphs, lists, tables, bold, emphasis and code. Built as
 * React elements rather than HTML, so nothing an author wrote is ever markup.
 */
import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={m.index}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={m.index}>{m[2]}</strong>);
    else out.push(<em key={m.index}>{m[3]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isList = (l: string) => /^\s*([-*]|\d+\.)\s+/.test(l);

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const key = blocks.length;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      // the page's own title is its h1, from the page's name; a body's headings start one below it
      const level = Math.min(heading[1]!.length + 1, 4);
      const Tag = `h${level}` as "h2" | "h3" | "h4";
      if (heading[1]!.length > 1) blocks.push(<Tag key={key}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (isList(lines[i] ?? "") || /^\s{2,}\S/.test(lines[i] ?? ""))) {
        const l = lines[i] ?? "";
        if (!isList(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else items.push(l.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key}>
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) rows.push(lines[i++] ?? "");
      const cells = (r: string) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [head = "", ...rest] = rows;
      blocks.push(
        <table key={key}>
          <thead>
            <tr>
              {cells(head).map((c, n) => (
                <th key={n}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rest
              .filter((r) => !/^\|\s*-/.test(r))
              .map((r, n) => (
                <tr key={n}>
                  {cells(r).map((c, m) => (
                    <td key={m}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i] ?? "")) para.push((lines[i++] ?? "").trim());
    blocks.push(<p key={key}>{inline(para.join(" "))}</p>);
  }
  return <Fragment>{blocks}</Fragment>;
}
