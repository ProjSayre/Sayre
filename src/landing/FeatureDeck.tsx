import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { lensGraphs } from "./lensGraphs";
import type { LensGraph } from "./lensGraphs";

const FEATURES = [
  {
    id: "onboarding",
    tab: "Onboarding",
    eyebrow: "view · new hire",
    title: "Find the first path through an unfamiliar repo.",
    body: "Follow dependencies in sequence, with prerequisite reading, setup steps, and guardrails attached to the files they govern.",
    details: ["sequenced reading", "sandboxed setup"],
  },
  {
    id: "product-map",
    tab: "Product map",
    eyebrow: "view · product",
    title: "See the feature, not the folder structure.",
    body: "Feature boundaries gather the files, team, tickets, and recent edits that make a customer-facing capability real.",
    details: ["cross-folder features", "work attached to code"],
  },
  {
    id: "team-access",
    tab: "Team access",
    eyebrow: "control · ownership",
    title: "Ownership and access, beside the code.",
    body: "See who owns an area and scope what each person or agent may read—down to an organization, repository, branch, or path.",
    details: ["history-derived owners", "scoped access"],
  },
  {
    id: "agent-context",
    tab: "Agent context",
    eyebrow: "context · MCP trace",
    title: "See what Sayre served—and what changed since.",
    body: "Sayre uses graph-guided retrieval to serve a bounded, RBAC-filtered slice over MCP. The same graph shows humans what was served—and where that context is now stale or incomplete.",
    details: ["curated graph context", "visible context health"],
  },
  {
    id: "live-sync",
    tab: "Live sync",
    eyebrow: "signal · live graph",
    title: "A living map, not another stale diagram.",
    body: "GitHub push events reparse only the changed files and patch authorized open canvases in place, with a 15-second sync target.",
    details: ["delta-only parsing", "live canvas patches"],
  },
] as const;

type FeatureId = (typeof FEATURES)[number]["id"];
type Direction = "next" | "previous";

function FeatureGraph({ graph, variant, showLabels = true }: { graph: LensGraph; variant: string; showLabels?: boolean }): JSX.Element {
  return (
    <svg
      className={`v2-feature-graph v2-feature-graph--${variant}`}
      viewBox={graph.vb}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {graph.edges.map((edge, index) => (
        <line
          key={`edge-${index}`}
          x1={edge.x1}
          y1={edge.y1}
          x2={edge.x2}
          y2={edge.y2}
          stroke={edge.stroke}
          strokeWidth={edge.w}
          opacity={edge.op}
          strokeDasharray={edge.dash === "none" ? undefined : edge.dash}
        />
      ))}
      {graph.rings.map((node, index) => (
        <circle
          key={`ring-${index}`}
          cx={node.x}
          cy={node.y}
          r={node.r}
          fill={node.fill}
          stroke={node.stroke}
          strokeWidth={node.sw}
          strokeDasharray={node.dash === "none" ? undefined : node.dash}
        />
      ))}
      {graph.dots.map((node, index) => (
        <circle key={`dot-${index}`} cx={node.x} cy={node.y} r={node.r} fill={node.fill} />
      ))}
      {showLabels && graph.labels.map((label, index) => (
        <text
          key={`label-${index}`}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor as "start" | "middle" | "end"}
          style={{
            fontFamily: "'Fragment Mono', monospace",
            fontSize: label.fs,
            fill: label.fill,
            fontWeight: label.fw,
            paintOrder: "stroke",
            stroke: "#0D0E0C",
            strokeWidth: 3,
          }}
        >
          {label.label}
        </text>
      ))}
    </svg>
  );
}

function GraphOverlay({ graph, className, children }: { graph: LensGraph; className: string; children: ReactNode }): JSX.Element {
  return (
    <svg
      className={`v2-concept-graph-overlay ${className}`}
      viewBox={graph.vb}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function graphBounds(graph: LensGraph): { x: number; y: number; width: number; height: number } {
  const [x, y, width, height] = graph.vb.split(/\s+/).map(Number);
  return { x, y, width, height };
}

function ArtifactFrame({ feature, meta, status, children }: { feature: FeatureId; meta: string; status: string; children: ReactNode }): JSX.Element {
  return (
    <div className="v2-artifact" data-feature={feature} aria-hidden="true">
      <div className="v2-artifact__bar">
        <span className="v2-artifact__repo">acme/monorepo</span>
        <span className="v2-artifact__meta">{meta}</span>
        <span className="v2-artifact__live">
          <span /> {status}
        </span>
      </div>
      <div className="v2-artifact__body">{children}</div>
    </div>
  );
}

function ConceptStage({ feature, label, children }: { feature: FeatureId; label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="v2-concept" data-feature={feature} aria-hidden="true">
      <span className="v2-concept__kicker">capability sketch</span>
      <div className="v2-concept__field">{children}</div>
      <div className="v2-concept__caption">
        <span>{label}</span>
        <b>conceptual system diagram</b>
      </div>
    </div>
  );
}

function OnboardingArtifact({ graph }: { graph: LensGraph }): JSX.Element {
  return (
    <ArtifactFrame feature="onboarding" meta="onboarding view · main" status="product concept">
      <div className="v2-artifact__split v2-artifact__split--onboarding">
        <div className="v2-artifact__graphwell">
          <FeatureGraph graph={graph} variant="onboarding" />
          <span className="v2-artifact__scope">first path · apps/</span>
        </div>
        <div className="v2-onboarding-rail">
          <div className="v2-artifact__section-label">your first path</div>
          <div className="v2-onboarding-step is-done">
            <span>01</span>
            <div>
              <strong>Read the entry point</strong>
              <small>useCheckout.ts</small>
            </div>
          </div>
          <div className="v2-onboarding-step is-active">
            <span>02</span>
            <div>
              <strong>Apply the guardrail</strong>
              <small>amounts stay in integer minor units</small>
            </div>
          </div>
          <div className="v2-onboarding-step">
            <span>03</span>
            <div>
              <strong>Configure the webhook</strong>
              <small>stripe listen → localhost:3000</small>
            </div>
          </div>
          <div className="v2-onboarding-step">
            <span>04</span>
            <div>
              <strong>Verify the path</strong>
              <small>checkout.e2e.ts</small>
            </div>
          </div>
          <div className="v2-onboarding-command">
            <span>$</span> pnpm dev
            <b>sandboxed</b>
          </div>
        </div>
      </div>
    </ArtifactFrame>
  );
}

function ProductMapArtifact({ graph }: { graph: LensGraph }): JSX.Element {
  return (
    <ArtifactFrame feature="product-map" meta="product view · main" status="source-backed">
      <div className="v2-artifact__split v2-artifact__split--product">
        <div className="v2-artifact__graphwell">
          <FeatureGraph graph={graph} variant="product" />
          <span className="v2-artifact__scope">feature · checkout</span>
        </div>
        <div className="v2-feature-inspector">
          <div className="v2-feature-inspector__heading">
            <span>feature</span>
            <strong>Checkout</strong>
          </div>
          <dl>
            <div>
              <dt>Description</dt>
              <dd>Card payment, promotion, and guest-cart flow.</dd>
            </div>
            <div>
              <dt>Team</dt>
              <dd><span className="v2-team-dot" /> Web platform</dd>
            </div>
            <div>
              <dt>Files included</dt>
              <dd>9 · across 3 workspaces</dd>
            </div>
            <div>
              <dt>Recent edits</dt>
              <dd>PR #482 · Dana Park · 2d</dd>
            </div>
          </dl>
          <div className="v2-feature-ticket">
            <span>LIN-482</span>
            <strong>payment intents migration</strong>
            <small>in progress</small>
          </div>
        </div>
      </div>
    </ArtifactFrame>
  );
}

function TeamAccessArtifact({ graph }: { graph: LensGraph }): JSX.Element {
  return (
    <ConceptStage feature="team-access" label="ownership · effective scope">
      <div className="v2-concept-graph v2-concept-team__graph">
        <FeatureGraph graph={graph} variant="team-concept" showLabels={false} />
      </div>
      <svg className="v2-concept-team__links" viewBox="0 0 1000 600" preserveAspectRatio="none">
        <path d="M145 208 C260 208 268 282 380 282" />
        <path d="M145 402 C254 402 286 344 418 344" />
      </svg>
      <div className="v2-concept-team__boundary v2-concept-team__boundary--outer"><span>repository</span></div>
      <div className="v2-concept-team__boundary v2-concept-team__boundary--inner"><span>effective scope</span></div>
      <div className="v2-concept-principal v2-concept-principal--owner"><i>H</i><span>owner</span></div>
      <div className="v2-concept-principal v2-concept-principal--agent"><i>A</i><span>agent · read only</span></div>
      <div className="v2-concept-team__idea v2-concept-team__idea--ownership"><span>ownership</span><strong>follows the graph</strong></div>
      <div className="v2-concept-team__idea v2-concept-team__idea--access"><span>access</span><strong>stops at the boundary</strong></div>
    </ConceptStage>
  );
}

function AgentContextArtifact({ graph }: { graph: LensGraph }): JSX.Element {
  const checkout = graph.anchors["apps/web/src/checkout"];
  const paymentForm = graph.anchors["apps/web/src/checkout/PaymentForm.tsx"];
  const missingTest = graph.anchors["apps/web/src/checkout/useCheckout.test.ts"];
  const bounds = graphBounds(graph);
  const boundaryX = (checkout.x + paymentForm.x) / 2;
  const boundaryY = (checkout.y + paymentForm.y) / 2;
  const boundaryRadiusX = Math.abs(checkout.x - paymentForm.x) / 2 + 48;
  const boundaryRadiusY = 86;
  const scopePort = { x: boundaryX + boundaryRadiusX, y: boundaryY };
  const agent = { x: bounds.x + bounds.width + 270, y: boundaryY - 220 };
  const agentPort = { x: agent.x - 42, y: agent.y };
  const outboundPath = `M ${scopePort.x} ${scopePort.y} C ${scopePort.x + 145} ${scopePort.y}, ${agentPort.x - 150} ${agentPort.y}, ${agentPort.x} ${agentPort.y}`;
  const tracePath = `M ${agent.x - 24} ${agent.y + 34} C ${agent.x - 110} ${agent.y + 150}, ${boundaryX + 105} ${boundaryY + 122}, ${boundaryX} ${boundaryY + boundaryRadiusY}`;

  return (
    <ConceptStage feature="agent-context" label="bounded context · visible provenance">
      <div className="v2-concept-graph v2-concept-agent__graph">
        <FeatureGraph graph={graph} variant="agent-concept" showLabels={false} />
        <GraphOverlay graph={graph} className="v2-concept-agent__overlay">
          <ellipse
            className="v2-concept-agent__boundary"
            cx={boundaryX}
            cy={boundaryY}
            rx={boundaryRadiusX}
            ry={boundaryRadiusY}
            vectorEffect="non-scaling-stroke"
          />
          <text className="v2-concept-agent__boundary-label" x={boundaryX - boundaryRadiusX + 12} y={boundaryY - boundaryRadiusY - 12}>
            bounded slice
          </text>
          <g className="v2-concept-agent__node-state v2-concept-agent__node-state--changed">
            <circle cx={paymentForm.x} cy={paymentForm.y} r="15" vectorEffect="non-scaling-stroke" />
          </g>
          <g className="v2-concept-agent__node-state v2-concept-agent__node-state--missing">
            <circle cx={missingTest.x} cy={missingTest.y} r="13" vectorEffect="non-scaling-stroke" />
          </g>
          <path className="v2-concept-agent__flow-path is-outbound" d={outboundPath} vectorEffect="non-scaling-stroke" />
          <path className="v2-concept-agent__flow-path is-trace" d={tracePath} vectorEffect="non-scaling-stroke" />
          {[0, 1, 2].map((index) => (
            <circle className="v2-concept-agent__packet" key={`packet-${index}`} r="5">
              <animateMotion
                begin={`${index * 0.14}s`}
                calcMode="linear"
                dur="8s"
                keyPoints="0;1;1"
                keyTimes="0;0.22;1"
                path={outboundPath}
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                begin={`${index * 0.14}s`}
                dur="8s"
                keyTimes="0;0.03;0.18;0.24;1"
                repeatCount="indefinite"
                values="0;1;0.72;0;0"
              />
            </circle>
          ))}
          <g className="v2-concept-agent__destination" transform={`translate(${agent.x} ${agent.y})`}>
            <polygon points="-42,0 -21,-36 21,-36 42,0 21,36 -21,36" vectorEffect="non-scaling-stroke" />
            <text className="is-letter" x="0" y="4" textAnchor="middle">A</text>
            <text className="is-label" x="0" y="58" textAnchor="middle">agent</text>
          </g>
          <text className="v2-concept-agent__flow-label" x={agent.x - 195} y={agent.y - 52}>
            <tspan x={agent.x - 195}>graph-guided context</tspan>
            <tspan className="is-accent" x={agent.x - 195} dy="15">over MCP</tspan>
          </text>
          <text className="v2-concept-agent__trace-label" x={agent.x - 178} y={agent.y + 118}>human-visible trace</text>
          <text className="v2-concept-agent__time is-served" x={boundaryX - boundaryRadiusX - 74} y={boundaryY + boundaryRadiusY + 8}>served t₀</text>
          <text className="v2-concept-agent__time is-current" x={bounds.x + bounds.width * 0.56} y={bounds.y + 74}>graph t₁</text>
        </GraphOverlay>
      </div>
    </ConceptStage>
  );
}

function LiveSyncArtifact({ graph }: { graph: LensGraph }): JSX.Element {
  const checkout = graph.anchors["apps/web/src/checkout"];
  const changedNodes = [
    graph.anchors["apps/web/src/checkout/OrderConfirmation.tsx"],
    graph.anchors["apps/web/src/checkout/PaymentForm.tsx"],
    graph.anchors["apps/web/src/checkout/useCheckout.test.ts"],
  ];
  const bounds = graphBounds(graph);
  const scanDistance = bounds.width - 36;

  return (
    <ConceptStage feature="live-sync" label="push · changed slice · graph patch">
      <div className="v2-concept-graph v2-concept-sync__graph">
        <FeatureGraph graph={graph} variant="sync-concept" showLabels={false} />
        <GraphOverlay graph={graph} className="v2-concept-sync__overlay">
          {changedNodes.map((node, index) => (
            <line
              className={`v2-concept-sync__patch-edge is-${index + 1}`}
              key={`patch-edge-${index}`}
              x1={checkout.x}
              y1={checkout.y}
              x2={node.x}
              y2={node.y}
              pathLength="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            className="v2-concept-sync__sweep"
            x1={bounds.x + 18}
            x2={bounds.x + 18}
            y1={bounds.y + 64}
            y2={bounds.y + bounds.height - 34}
            vectorEffect="non-scaling-stroke"
            style={{ "--v2-scan-distance": `${scanDistance}px` } as CSSProperties}
          />
          {changedNodes.map((node, index) => (
            <circle
              className={`v2-concept-sync__patch is-${index + 1}`}
              key={`patch-${index}`}
              cx={node.x}
              cy={node.y}
              r={index === 1 ? 18 : 17}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </GraphOverlay>
      </div>
      <svg className="v2-concept-sync__stream" viewBox="0 0 1000 600" preserveAspectRatio="none">
        <path d="M82 306 C190 306 218 306 326 306" />
      </svg>
      <div className="v2-concept-sync__origin"><i /><span>push</span></div>
      <div className="v2-concept-sync__delta"><i>Δ</i><span>changed slice</span></div>
      <div className="v2-concept-sync__target"><span>sync target</span><strong>≤15s</strong></div>
      <div className="v2-concept-sync__idea"><span>only the change moves</span><strong>the map stays alive</strong></div>
    </ConceptStage>
  );
}

function featureArtifact(id: FeatureId): JSX.Element {
  const graphs = lensGraphs();
  if (id === "onboarding") return <OnboardingArtifact graph={graphs.g1} />;
  if (id === "product-map") return <ProductMapArtifact graph={graphs.g3} />;
  if (id === "team-access") return <TeamAccessArtifact graph={graphs.g2} />;
  if (id === "agent-context") return <AgentContextArtifact graph={graphs.g2} />;
  return <LiveSyncArtifact graph={graphs.g2} />;
}

export function FeatureDeck(): JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState<Direction>("next");
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeFeature = FEATURES[activeIndex];

  const centerTab = (index: number): void => {
    const rail = tabListRef.current;
    const tab = tabRefs.current[index];
    if (!rail || !tab || rail.scrollWidth <= rail.clientWidth) return;
    const left = tab.offsetLeft - (rail.clientWidth - tab.offsetWidth) / 2;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rail.scrollTo({ left, behavior: reduced ? "auto" : "smooth" });
  };

  const selectFeature = (nextIndex: number): void => {
    if (nextIndex < 0 || nextIndex >= FEATURES.length) return;
    if (nextIndex === activeIndex) {
      centerTab(nextIndex);
      return;
    }
    setDirection(nextIndex > activeIndex ? "next" : "previous");
    setActiveIndex(nextIndex);
    window.requestAnimationFrame(() => centerTab(nextIndex));
  };

  const moveTabFocus = (nextIndex: number): void => {
    selectFeature(nextIndex);
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus());
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveTabFocus(index === FEATURES.length - 1 ? 0 : index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveTabFocus(index === 0 ? FEATURES.length - 1 : index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTabFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTabFocus(FEATURES.length - 1);
    }
  };

  return (
    <section className="v2-features" id="features" aria-labelledby="feature-deck-title">
      <div className="v2-features__head">
        <div>
          <span className="v2-eyebrow">one graph · five working modes</span>
          <h2 className="v2-h2" id="feature-deck-title">One graph. Five ways to put it to work.</h2>
        </div>
        <p>Move through the views, controls, and context that turn a repository into shared infrastructure for people and agents.</p>
        <div className="v2-features__controls" aria-label="Feature carousel controls">
          <span className="v2-features__count" aria-hidden="true">
            {String(activeIndex + 1).padStart(2, "0")} / {String(FEATURES.length).padStart(2, "0")}
          </span>
          <button
            type="button"
            className="v2-features__arrow"
            onClick={() => selectFeature(activeIndex - 1)}
            disabled={activeIndex === 0}
            aria-label={activeIndex === 0 ? "No previous feature" : `Previous feature: ${FEATURES[activeIndex - 1].tab}`}
          >
            <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M11.5 4.5 7 9l4.5 4.5M7.5 9H15" /></svg>
          </button>
          <button
            type="button"
            className="v2-features__arrow"
            onClick={() => selectFeature(activeIndex + 1)}
            disabled={activeIndex === FEATURES.length - 1}
            aria-label={activeIndex === FEATURES.length - 1 ? "No next feature" : `Next feature: ${FEATURES[activeIndex + 1].tab}`}
          >
            <svg viewBox="0 0 18 18" aria-hidden="true"><path d="m6.5 4.5 4.5 4.5-4.5 4.5M3 9h7.5" /></svg>
          </button>
        </div>
      </div>

      <div ref={tabListRef} className="v2-features__tabs" role="tablist" aria-label="Sayre capabilities">
        {FEATURES.map((feature, index) => (
          <button
            key={feature.id}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={`feature-tab-${feature.id}`}
            aria-selected={index === activeIndex}
            aria-controls={`feature-panel-${feature.id}`}
            tabIndex={index === activeIndex ? 0 : -1}
            className={index === activeIndex ? "is-active" : undefined}
            onClick={() => selectFeature(index)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {feature.tab}
          </button>
        ))}
      </div>

      <div className="v2-feature-deck">
        <article
          key={activeFeature.id}
          className={`v2-feature-panel is-${direction}`}
          role="tabpanel"
          id={`feature-panel-${activeFeature.id}`}
          aria-labelledby={`feature-tab-${activeFeature.id}`}
          tabIndex={0}
        >
          <div className="v2-feature-panel__copy">
            <span className="v2-eyebrow v2-eyebrow--accent">{activeFeature.eyebrow}</span>
            <h3>{activeFeature.title}</h3>
            <p>{activeFeature.body}</p>
            <ul>
              {activeFeature.details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </div>
          <div className={`v2-feature-panel__visual${activeIndex >= 2 ? " is-concept" : ""}`}>
            {featureArtifact(activeFeature.id)}
          </div>
        </article>
      </div>

      <p className="v2-visually-hidden" aria-live="polite">
        Showing feature {activeIndex + 1} of {FEATURES.length}: {activeFeature.tab}
      </p>
    </section>
  );
}
