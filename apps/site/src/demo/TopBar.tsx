import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { NODE_BY_ID, PERSONAS, ROOT_FILE_COUNT, ancestorIds } from "../data";
import type { PersonaId, Tab } from "../data";
import { Button } from "../shared/Button";
import { useDemoDispatch, useDemoState } from "./state";

const TABS: Tab[] = ["filetree", "features", "relations"];

const SEGMENT_LABELS: Record<PersonaId, string> = {
  "new-hire": "new hire",
  "tech-lead": "tech lead",
  pm: "pm",
};

/**
 * Two-row demo header (design v2): brand row — wordmark, repo, sync meta,
 * persona segments, CTA; tab row — view tabs + the selection/scope breadcrumb.
 */
export function TopBar({ onEarlyAccess, isMobile }: { onEarlyAccess: () => void; isMobile: boolean }): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();

  return (
    <header className="topbar">
      <div className="topbar__row topbar__row--brand">
        <Link to="/" className="wordmark" aria-label="sayre home">
          <span className="wordmark__full">sayre_</span>
          <span className="wordmark__short" aria-hidden="true">
            s_
          </span>
        </Link>
        {!isMobile && (
          <>
            <span className="topbar__repo">acme/monorepo</span>
            <span className="topbar__meta">main · {ROOT_FILE_COUNT.toLocaleString("en-US")} files · synced 2m ago</span>
          </>
        )}
        <div className="topbar__right">
          {!isMobile && <PersonaSegments />}
          <Button small onClick={onEarlyAccess} className="topbar__cta">
            {isMobile ? "join waitlist" : "join the waitlist"}
          </Button>
          {isMobile && <OverflowMenu />}
        </div>
      </div>

      <div className="topbar__row topbar__row--tabs">
        <div className="topbar__tabs" role="tablist" aria-label="views">
          {TABS.map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={state.tab === tab}
              className={state.tab === tab ? "topbar__tab is-active" : "topbar__tab"}
              onClick={() => dispatch({ type: "setTab", tab })}
            >
              <span className="topbar__tab-dot" aria-hidden="true" />
              {tab}
            </button>
          ))}
        </div>
        {!isMobile && <HeaderBreadcrumb />}
      </div>
    </header>
  );
}

/** the current place in the repo: relations scope, or the selection's directory chain */
function HeaderBreadcrumb(): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();

  let chain: string[];
  if (state.tab === "relations") {
    chain = [...ancestorIds(state.relationsScope), state.relationsScope];
  } else if (state.selectedId) {
    const node = NODE_BY_ID.get(state.selectedId);
    chain = node ? (node.type === "file" ? ancestorIds(node.id) : [...ancestorIds(node.id), node.id]) : ["acme"];
  } else {
    chain = ["acme"];
  }

  const go = (id: string): void => {
    if (state.tab === "relations") dispatch({ type: "setScope", id });
    else dispatch({ type: "selectNode", id });
  };

  return (
    <nav className="topbar__crumb" aria-label={state.tab === "relations" ? "relations scope" : "selection path"}>
      {chain.map((id, i) => {
        const node = NODE_BY_ID.get(id);
        if (!node) return null;
        const isLast = i === chain.length - 1;
        return (
          <span key={id}>
            {i > 0 && <span className="topbar__crumb-sep"> › </span>}
            {isLast ? (
              <span className="topbar__crumb-current">{node.name}/</span>
            ) : (
              <button className="topbar__crumb-link" onClick={() => go(id)}>
                {node.name}/
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** bordered segmented persona control — all three roles always visible */
export function PersonaSegments(): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  return (
    <div className="persona-seg" role="group" aria-label="view as">
      <span className="persona-seg__label" aria-hidden="true">
        view as
      </span>
      <div className="persona-seg__group">
        {PERSONAS.map((p) => (
          <button
            key={p.id}
            data-persona={p.id}
            aria-pressed={state.persona === p.id}
            className={state.persona === p.id ? "persona-seg__option is-active" : "persona-seg__option"}
            onClick={() => dispatch({ type: "setPersona", id: p.id })}
          >
            {SEGMENT_LABELS[p.id]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** dropdown variant — kept for the mobile overflow menu and bottom sheet */
export function PersonaSwitcher({ pinned = false }: { pinned?: boolean }): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const current = PERSONAS.find((p) => p.id === state.persona) ?? PERSONAS[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={pinned ? "persona persona--pinned" : "persona"} ref={wrapRef}>
      <span className="persona__label" id="persona-label">
        view as
      </span>
      <button
        className="persona__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="persona-label"
        onClick={() => setOpen((o) => !o)}
      >
        {current.label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="persona__menu" role="listbox" aria-label="view as">
          {PERSONAS.map((p) => (
            <li key={p.id}>
              <button
                role="option"
                aria-selected={p.id === state.persona}
                className={p.id === state.persona ? "persona__option is-active" : "persona__option"}
                onClick={() => {
                  dispatch({ type: "setPersona", id: p.id });
                  setOpen(false);
                }}
              >
                <span className="persona__dot" aria-hidden="true" />
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OverflowMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="overflow" ref={wrapRef}>
      <button className="overflow__button" aria-haspopup="true" aria-expanded={open} aria-label="more" onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="overflow__menu">
          <span className="topbar__meta overflow__meta">
            acme/monorepo · {ROOT_FILE_COUNT.toLocaleString("en-US")} files
          </span>
          <PersonaSwitcher />
        </div>
      )}
    </div>
  );
}
