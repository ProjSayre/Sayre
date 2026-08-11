// CH-06 red suite — the safe block-level markdown parser behind the answer.
// Authored from .pipeline/spec.md before any implementation exists.

import { describe, expect, it } from 'vitest';
import { parseAnswerBlocks, type AnswerBlock } from './answerMarkdown';

const ALLOWED_BLOCK_TYPES = ['paragraph', 'heading', 'list', 'code'];

function keysOf(block: AnswerBlock): string[] {
  return Object.keys(block).sort();
}

describe('answer markdown blocks', () => {
  // @spec AC-4
  it('parses ATX headings, fenced code, bullets, ordered items, and blank-line paragraphs', () => {
    const answer = [
      '# Checkout',
      '',
      '## Payments',
      '',
      '### Cart',
      '',
      'The checkout folder owns the cart-to-confirmation flow.',
      '',
      '- PaymentForm.tsx captures the card',
      '* useCart.ts holds the cart state',
      '',
      '1. Read CheckoutPage.tsx',
      '2. Read PaymentForm.tsx',
      '',
      '```',
      'npm run dev:workspaces',
      '```',
      '',
      'It ends here.',
    ].join('\n');

    expect(parseAnswerBlocks(answer)).toEqual([
      { type: 'heading', level: 1, text: 'Checkout' },
      { type: 'heading', level: 2, text: 'Payments' },
      { type: 'heading', level: 3, text: 'Cart' },
      { type: 'paragraph', text: 'The checkout folder owns the cart-to-confirmation flow.' },
      { type: 'list', ordered: false, items: ['PaymentForm.tsx captures the card', 'useCart.ts holds the cart state'] },
      { type: 'list', ordered: true, items: ['Read CheckoutPage.tsx', 'Read PaymentForm.tsx'] },
      { type: 'code', text: 'npm run dev:workspaces' },
      { type: 'paragraph', text: 'It ends here.' },
    ]);
  });

  // @spec AC-17
  it('emits only the four block shapes and never a url, href, or html field', () => {
    const blocks = parseAnswerBlocks([
      '## See https://example.com/docs',
      '',
      'Read https://example.com/docs and mailto:ops@example.com for more.',
      '',
      '- https://example.com/one',
      '',
      '```',
      'curl https://example.com',
      '```',
    ].join('\n'));

    for (const block of blocks) {
      expect(ALLOWED_BLOCK_TYPES).toContain(block.type);
      expect(keysOf(block).some((key) => /href|url|html|link|anchor/i.test(key))).toBe(false);
    }
    expect(blocks).toContainEqual({ type: 'paragraph', text: 'Read https://example.com/docs and mailto:ops@example.com for more.' });
    expect(blocks).toContainEqual({ type: 'heading', level: 2, text: 'See https://example.com/docs' });
  });

  // @spec EC-21
  it('passes raw HTML, script tags, and javascript: URLs through as literal, uninterpreted text', () => {
    const hostile = [
      '<script>alert("xss")</script>',
      '',
      '<img src=x onerror="alert(1)">',
      '',
      '- [click me](javascript:alert(1))',
      '',
      '```',
      '<script>alert("in code")</script>',
      '```',
      '',
      'Inline **bold** and `code` stay literal.',
    ].join('\n');

    const blocks = parseAnswerBlocks(hostile);
    for (const block of blocks) {
      expect(ALLOWED_BLOCK_TYPES).toContain(block.type);
    }
    expect(blocks).toContainEqual({ type: 'paragraph', text: '<script>alert("xss")</script>' });
    expect(blocks).toContainEqual({ type: 'paragraph', text: '<img src=x onerror="alert(1)">' });
    expect(blocks).toContainEqual({ type: 'list', ordered: false, items: ['[click me](javascript:alert(1))'] });
    expect(blocks).toContainEqual({ type: 'code', text: '<script>alert("in code")</script>' });
    expect(blocks).toContainEqual({ type: 'paragraph', text: 'Inline **bold** and `code` stay literal.' });
  });

  // @spec AC-4
  it('returns no blocks for an empty or whitespace-only answer', () => {
    expect(parseAnswerBlocks('')).toEqual([]);
    expect(parseAnswerBlocks('   \n\n  \n')).toEqual([]);
  });
});
