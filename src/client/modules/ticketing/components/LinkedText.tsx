import { Fragment, type ReactNode } from "react";

// Jira Data Center hands descriptions and comments back as wiki markup, so a
// link is either a bare URL or `[text|url]` / `[url]`. Only http(s) becomes an
// anchor — a `javascript:` URL in a ticket must stay text.
const LINK_RE = /\[([^\[\]|]*)\|(https?:\/\/[^\s\]]+)\]|\[(https?:\/\/[^\s\]|]+)\]|(https?:\/\/[^\s<>"]+)/g;

// A URL at the end of a sentence carries its full stop; one in parentheses
// carries the closing bracket. Neither is part of the address.
function trimTrailing(url: string): [string, string] {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (".,;:!?'\"".includes(ch)) end--;
    else if (ch === ")" && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end--;
    else break;
  }
  return [url.slice(0, end), url.slice(end)];
}

export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    let href: string;
    let label: string;
    let tail = "";
    if (m[2]) {
      href = m[2];
      label = m[1].trim() || m[2];
    } else if (m[3]) {
      href = label = m[3];
    } else {
      [href, tail] = trimTrailing(m[4]);
      label = href;
    }
    out.push(
      <a key={start} href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
    if (tail) out.push(tail);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function LinkedText({ text }: { text: string }) {
  return <>{linkify(text).map((part, i) => <Fragment key={i}>{part}</Fragment>)}</>;
}
