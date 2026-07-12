import type { ReactNode } from "react";

// Tiny renderer for the agentMd fragments — h4 / strong / code / ul only (§8.2).

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }): JSX.Element {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let key = 0;

  const flushList = (): void => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`}>
        {list.map((item, i) => (
          <li key={i}>{inline(item, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      continue;
    }
    flushList();
    if (line.startsWith("#### ")) {
      blocks.push(<h4 key={`h-${key++}`}>{inline(line.slice(5), `h-${key}`)}</h4>);
    } else if (line.trim() !== "") {
      blocks.push(<p key={`p-${key++}`}>{inline(line, `p-${key}`)}</p>);
    }
  }
  flushList();

  return <div className="agent-md__body">{blocks}</div>;
}
