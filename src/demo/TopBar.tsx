import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PERSONAS, ROOT_FILE_COUNT } from "../data";
import type { Tab } from "../data";
import { Button } from "../shared/Button";
import { useDemoDispatch, useDemoState } from "./state";

const TABS: Tab[] = ["filetree", "features", "relations"];

export function TopBar({ onEarlyAccess, isMobile }: { onEarlyAccess: () => void; isMobile: boolean }): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();

  return (
    <header className="topbar">
      <Link to="/" className="wordmark" aria-label="sayre home">
        <span className="wordmark__full">sayre_</span>
        <span className="wordmark__short" aria-hidden="true">
          s_
        </span>
      </Link>

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

      <div className="topbar__right">
        {!isMobile && (
          <>
            <PersonaSwitcher />
            <span className="topbar__meta">
              acme/monorepo · {ROOT_FILE_COUNT.toLocaleString("en-US")} files
            </span>
          </>
        )}
        <Button small onClick={onEarlyAccess} className="topbar__cta">
          {isMobile ? "early access" : "get early access"}
        </Button>
        {isMobile && <OverflowMenu />}
      </div>
    </header>
  );
}

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
