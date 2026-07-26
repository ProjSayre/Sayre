'use client';

import { useState, type ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'ready' | 'working' | 'warn' | 'danger';

export function Badge({
  tone = 'neutral',
  dot = true,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`mock-badge mock-badge-${tone}`}>
      {dot && <span className="mock-badge-dot" />}
      {children}
    </span>
  );
}

/** A collapsible drawer module. The drawer is assembled from these slots. */
export function Module({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number | string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mock-module">
      <button
        type="button"
        className="mock-module-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mock-module-chevron">{open ? '▾' : '▸'}</span>
        <h3>{title}</h3>
        {count !== undefined && <span className="mock-module-count">{count}</span>}
      </button>
      {open && <div className="mock-module-body">{children}</div>}
    </section>
  );
}

/**
 * A surface whose backend exists but has no browser-callable route yet. It is
 * deliberately inert — no button here may look like it does something.
 */
export function Reserved({
  children,
  tag = 'not yet available',
}: {
  children: ReactNode;
  tag?: string;
}) {
  return (
    <div className="mock-reserved">
      <span className="mock-reserved-tag">{tag}</span>
      <p>{children}</p>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="mock-empty">{children}</p>;
}

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    let timeout: number | undefined;
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_resolve, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error('Clipboard request timed out.')),
            250,
          );
        }),
      ]);
      if (timeout !== undefined) window.clearTimeout(timeout);
      return true;
    } catch {
      if (timeout !== undefined) window.clearTimeout(timeout);
      // Some embedded/automated browsers deny or stall the async clipboard
      // even on a secure page. Keep the ordinary select-and-copy fallback.
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return `${DATE_FORMAT.format(new Date(parsed))} UTC`;
}
