/**
 * Safe, block-level-only markdown parser for the chat answer.
 *
 * Recognizes ATX headings (#, ##, ###), fenced code (```), '-'/'*' bullets,
 * 'n.' ordered items, and blank-line-separated paragraphs. Inline markup, raw
 * HTML, and URLs are NEVER interpreted — every `text`/`items` value here is
 * emitted verbatim by the renderer into a React text node, and no anchor or
 * `dangerouslySetInnerHTML` is ever constructed from it (AC-17, EC-21).
 */

export type AnswerBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; text: string };

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const ORDERED_RE = /^\d+\.\s+(.*)$/;

function isFence(line: string): boolean {
  return line.trim().startsWith('```');
}

export function parseAnswerBlocks(answer: string): AnswerBlock[] {
  const lines = answer.split(/\r\n|\r|\n/);
  const blocks: AnswerBlock[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
    paragraphLines = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    if (isFence(line)) {
      flushParagraph();
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !isFence(lines[index]!)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1; // consume the closing fence
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch !== null) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: headingMatch[1]!.length as 1 | 2 | 3,
        text: headingMatch[2]!.trim(),
      });
      index += 1;
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch !== null) {
      flushParagraph();
      const items: string[] = [bulletMatch[1]!.trim()];
      index += 1;
      while (index < lines.length) {
        const nextMatch = BULLET_RE.exec(lines[index]!);
        if (nextMatch === null) break;
        items.push(nextMatch[1]!.trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    const orderedMatch = ORDERED_RE.exec(line);
    if (orderedMatch !== null) {
      flushParagraph();
      const items: string[] = [orderedMatch[1]!.trim()];
      index += 1;
      while (index < lines.length) {
        const nextMatch = ORDERED_RE.exec(lines[index]!);
        if (nextMatch === null) break;
        items.push(nextMatch[1]!.trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    paragraphLines.push(line.trim());
    index += 1;
  }

  flushParagraph();
  return blocks;
}
