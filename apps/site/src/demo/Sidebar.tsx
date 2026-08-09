import { useEffect, useRef, useState } from "react";
import {
  CONTRIBUTOR_COUNT,
  FEATURES,
  FEATURE_BY_ID,
  NODE_BY_ID,
  REPO_OVERVIEW,
  ROOT_FILE_COUNT,
  TICKET_BY_ID,
  ownerNames,
} from "../data";
import type { Change, RepoNode } from "../data";
import { Chip } from "../shared/Chip";
import { Markdown } from "./Markdown";
import { fileCounterparts, rollupScope } from "./canvas/rollup";
import { FeaturePanel } from "./FeaturePanel";
import { LAYER_LABELS, LAYER_ORDER, useCanvasBus, useDemoDispatch, useDemoState } from "./state";
import type { LayerKey } from "../data";

export function Sidebar({ variant = "desktop" }: { variant?: "desktop" | "sheet" }): JSX.Element {
  const state = useDemoState();

  const feature = state.tab === "features" && state.selectedFeatureId ? FEATURE_BY_ID.get(state.selectedFeatureId) : null;
  const node = state.selectedId ? NODE_BY_ID.get(state.selectedId) : null;

  return (
    <div className="sidebar__inner">
      {feature ? <FeaturePanel feature={feature} /> : node ? <NodePanel node={node} /> : <Overview variant={variant} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §8.5 nothing selected
// ---------------------------------------------------------------------------

function Overview({ variant }: { variant: "desktop" | "sheet" }): JSX.Element {
  return (
    <div className="overview">
      <div className="overview__repo">acme/monorepo</div>
      <div className="overview__stats">
        {ROOT_FILE_COUNT.toLocaleString("en-US")} files · {FEATURES.length} features · {CONTRIBUTOR_COUNT} contributors
      </div>
      <p className="overview__desc">{REPO_OVERVIEW}</p>
      <div className="overview__hints">
        <div>click a node to inspect it</div>
        <div>⌘k to search files</div>
        <div>{variant === "sheet" ? "view as — at the top of this panel" : "view as — top right — changes what each role sees"}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §8.1–8.3 node anatomy
// ---------------------------------------------------------------------------

function NodePanel({ node }: { node: RepoNode }): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const isFile = node.type === "file";
  const owners = ownerNames(node.meta.owners);

  const statLine = isFile
    ? `file · ${node.meta.lang ?? "?"} · ${node.meta.loc ?? "—"} loc`
    : `folder · ${node.fileCount ?? 0} files`;

  return (
    <div className="nodepanel">
      <PathHeader node={node} />
      <div className="nodepanel__stat">{statLine}</div>
      {owners.length > 0 && (
        <div className="nodepanel__owners">
          <span className="nodepanel__owners-label">owned by </span>
          {owners.join(" · ")}
        </div>
      )}

      {state.tab === "relations" && <RelationsBlock node={node} />}

      <LayerToggles />

      {LAYER_ORDER.filter((k) => state.layers[k]).map((k) => (
        <LayerSection key={k} layer={k} node={node} dispatchTo={dispatch} />
      ))}
    </div>
  );
}

function PathHeader({ node }: { node: RepoNode }): JSX.Element {
  if (node.type === "root") {
    return (
      <div className="nodepanel__path">
        <span className="nodepanel__path-tail">acme/</span>
      </div>
    );
  }
  const i = node.id.lastIndexOf("/");
  const head = i === -1 ? "" : node.id.slice(0, i + 1);
  const tail = node.id.slice(i + 1) + (node.type === "folder" ? "/" : "");
  return (
    <div className="nodepanel__path">
      {head}
      <span className="nodepanel__path-tail">{tail}</span>
    </div>
  );
}

// §7.5 sidebar relations block — between owners row and layers block
function RelationsBlock({ node }: { node: RepoNode }): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();

  const goTo = (id: string): void => {
    const target = NODE_BY_ID.get(id);
    if (!target) return;
    if (target.type === "file") {
      dispatch({ type: "selectFileForTab", id });
    } else {
      dispatch({ type: "selectNode", id });
    }
    requestAnimationFrame(() => bus.current?.flyToNode(id));
  };

  let rows: { dir: "out" | "in"; label: string; id: string; count?: number }[] = [];
  let inCount = 0;
  let outCount = 0;
  let outsideScope = false;

  if (node.type === "file") {
    const { incoming, outgoing } = fileCounterparts(node.id, state.edgeKinds);
    inCount = incoming.length;
    outCount = outgoing.length;
    rows = [
      ...outgoing.map((e) => ({ dir: "out" as const, label: e.to, id: e.to })),
      ...incoming.map((e) => ({ dir: "in" as const, label: e.from, id: e.from })),
    ];
  } else if (node.parentId !== state.relationsScope) {
    outsideScope = true;
  } else {
    const aggs = rollupScope(state.relationsScope, state.edgeKinds);
    const mine = aggs.filter((a) => a.fromId === node.id || a.toId === node.id);
    inCount = mine.filter((a) => a.toId === node.id).reduce((s, a) => s + a.count, 0);
    outCount = mine.filter((a) => a.fromId === node.id).reduce((s, a) => s + a.count, 0);
    rows = mine.map((a) =>
      a.fromId === node.id
        ? { dir: "out" as const, label: displayName(a.toId), id: a.toId, count: a.count }
        : { dir: "in" as const, label: displayName(a.fromId), id: a.fromId, count: a.count },
    );
  }

  return (
    <div className="relblock">
      {outsideScope ? (
        <div className="relblock__outside">outside the current scope</div>
      ) : (
        <>
          <div className="relblock__counts">
            in {inCount} · out {outCount}
          </div>
          {rows.map((r) => (
            <button key={`${r.dir}-${r.id}`} className="relblock__row" onClick={() => goTo(r.id)}>
              <span className="relblock__arrow">{r.dir === "out" ? "→" : "←"}</span> {r.label}
              {r.count !== undefined ? ` · ${r.count}` : ""}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function displayName(id: string): string {
  const n = NODE_BY_ID.get(id);
  if (!n) return id;
  return n.type === "file" ? id : id + "/";
}

// ---------------------------------------------------------------------------
// layers block
// ---------------------------------------------------------------------------

export function LayerToggles(): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  return (
    <div className="layers">
      <div className="section-heading">layers</div>
      {LAYER_ORDER.map((key, i) => (
        <label key={key} className="layers__row" style={{ transitionDelay: `${i * 0}ms` }}>
          <input
            type="checkbox"
            className="layers__checkbox-input"
            checked={state.layers[key]}
            onChange={(e) => dispatch({ type: "setLayer", key, on: e.target.checked })}
          />
          <span className="layers__checkbox" aria-hidden="true" />
          <span className="layers__label">{LAYER_LABELS[key]}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// sections (§8.2) + empty states (§8.3)
// ---------------------------------------------------------------------------

const EMPTY_TEXT: Record<LayerKey, string> = {
  description: "no summary for this node",
  dependencies: "no tracked dependencies",
  recentChanges: "no recent changes",
  features: "no linked features",
  tickets: "no linked tickets",
  agentMd: "no agent guidance for this node",
  tests: "not covered by tests",
};

function LayerSection({
  layer,
  node,
  dispatchTo,
}: {
  layer: LayerKey;
  node: RepoNode;
  dispatchTo: ReturnType<typeof useDemoDispatch>;
}): JSX.Element {
  const bus = useCanvasBus();
  const meta = node.meta;

  const heading = LAYER_LABELS[layer];

  const empty = (
    <section className="section">
      <div className="section-heading">{heading}</div>
      <div className="section-empty">{EMPTY_TEXT[layer]}</div>
    </section>
  );

  switch (layer) {
    case "description": {
      if (!meta.description) return empty;
      return (
        <section className="section">
          <div className="section-heading">{heading}</div>
          <p className="section-desc">{meta.description}</p>
          <div className="section-credit">generated by sayre · sample</div>
        </section>
      );
    }

    case "dependencies": {
      if (!meta.dependencies || meta.dependencies.length === 0) return empty;
      return (
        <section className="section">
          <div className="section-heading">{heading}</div>
          {meta.dependencies.map((d) => (
            <div key={d.name} className="dep">
              <div className="dep__head">
                <span className="dep__name">{d.name}</span>
                <Chip>{d.kind}</Chip>
              </div>
              {d.install && <CopyCommand command={d.install} />}
            </div>
          ))}
        </section>
      );
    }

    case "recentChanges": {
      if (!meta.recentChanges || meta.recentChanges.length === 0) return empty;
      return (
        <section className="section">
          <div className="section-heading">{heading}</div>
          {meta.recentChanges.slice(0, 3).map((c) => (
            <ChangeRow key={c.sha} change={c} />
          ))}
        </section>
      );
    }

    case "features": {
      if (!meta.featureIds || meta.featureIds.length === 0) return empty;
      return (
        <section className="section">
          <div className="section-heading">{heading}</div>
          <div className="section-chips">
            {meta.featureIds.map((fid) => {
              const f = FEATURE_BY_ID.get(fid);
              if (!f) return null;
              return (
                <button
                  key={fid}
                  className="feature-chip"
                  onClick={() => {
                    dispatchTo({ type: "setTab", tab: "features" });
                    dispatchTo({ type: "selectFeature", id: fid });
                  }}
                >
                  {f.name}
                </button>
              );
            })}
          </div>
        </section>
      );
    }

    case "tickets": {
      if (!meta.ticketIds || meta.ticketIds.length === 0) return empty;
      return (
        <section className="section">
          <div className="section-heading">{heading}</div>
          {meta.ticketIds.map((tid) => {
            const t = TICKET_BY_ID.get(tid);
            if (!t) return null;
            return (
              <div key={tid} className={t.status === "done" ? "ticket ticket--done" : "ticket"}>
                <Chip>{t.id}</Chip>
                <span className="ticket__title">{t.title}</span>
                <span className="ticket__status">{t.status}</span>
              </div>
            );
          })}
        </section>
      );
    }

    case "agentMd": {
      if (!meta.agentMd) return empty;
      return (
        <section className="section">
          <div className="section-heading">{heading}</div>
          <div className="agent-md">
            <div className="agent-md__header">AGENTS.md · scoped to this node</div>
            <Markdown source={meta.agentMd} />
          </div>
        </section>
      );
    }

    case "tests": {
      if (!meta.tests) return empty;
      const t = meta.tests;
      return (
        <section className="section">
          <div className="section-heading">{heading}</div>
          <div className={t.status === "pass" ? "tests-status tests-status--pass" : "tests-status tests-status--fail"}>
            {t.status === "pass" ? "passing" : "failing"}
          </div>
          <div className="tests-covered">
            <span className="tests-covered__label">covered by</span>
            {t.coveredBy.map((p) => (
              <button
                key={p}
                className="tests-covered__row"
                onClick={() => {
                  dispatchTo({ type: "selectFileForTab", id: p });
                  requestAnimationFrame(() => bus.current?.flyToNode(p));
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </section>
      );
    }
  }
}

export function ChangeRow({ change }: { change: Change }): JSX.Element {
  return (
    <div className="change">
      <div className="change__message">{change.message}</div>
      <div className="change__meta">
        {change.sha} · {change.author} · {change.when}
        {change.pr !== undefined && (
          <>
            {" · "}
            <Chip>pr #{change.pr}</Chip>
          </>
        )}
      </div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      className="copy-cmd"
      onClick={() => {
        void navigator.clipboard?.writeText(command).catch(() => undefined);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={`copy command: ${command}`}
    >
      <span className="copy-cmd__text">{command}</span>
      {copied && <span className="copy-cmd__copied">copied</span>}
    </button>
  );
}
