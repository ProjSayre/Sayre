import { describe, expect, it } from 'vitest';
import { parseTicketReferences } from './references';

describe('parseTicketReferences', () => {
  it('extracts and de-duplicates explicit File and Feature references', () => {
    expect(parseTicketReferences(
      'Touches [sayre:file:src/payments/charge.ts] and [sayre:feature:Checkout]. ' +
      '[sayre:file:src/payments/charge.ts]',
    )).toEqual([
      { kind: 'file', value: 'src/payments/charge.ts' },
      { kind: 'feature', value: 'Checkout' },
    ]);
  });

  it('returns no references for unrelated or absent descriptions', () => {
    expect(parseTicketReferences(null)).toEqual([]);
    expect(parseTicketReferences('ordinary issue text')).toEqual([]);
  });
});
