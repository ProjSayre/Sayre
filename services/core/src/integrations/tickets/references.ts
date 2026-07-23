import type { TicketReference } from './types';

const REFERENCE = /\[sayre:(file|feature):([^\]\r\n]+)\]/giu;

export function parseTicketReferences(description: string | null): TicketReference[] {
  if (description === null) return [];
  const seen = new Set<string>();
  const references: TicketReference[] = [];
  for (const match of description.matchAll(REFERENCE)) {
    const kind = match[1]?.toLowerCase();
    const value = match[2]?.trim();
    if ((kind !== 'file' && kind !== 'feature') || !value) continue;
    const key = `${kind}\0${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ kind, value });
  }
  return references;
}
