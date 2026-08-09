import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CONTACT_EMAIL } from "../config";
import { HOW_IT_WORKS, PROBLEM, V2_HERO, V2_HOW, V2_LAYERS, V2_LENSES, WAITLIST_BAND } from "../data/copy";
import { prefersReducedMotion } from "../demo/canvas/useCamera";
import { WaitlistForm } from "../shared/WaitlistForm";
import { FeatureDeck } from "./FeatureDeck";
import { HeroAnimeVideo } from "./HeroAnimeVideo";
import { lensGraphs } from "./lensGraphs";
import type { LensGraph } from "./lensGraphs";
import { GraphDivider, Reveal } from "./Reveal";

// s2 set dressing: scattered engineering sources in the margins connect and
// identify themselves as the memory-graph statement illuminates.
// th = scrub fraction at which each source attaches (matches word lighting).
const PROBLEM_DECOS: {
  x: number;
  y: number;
  kind: "folder" | "file";
  label: string;
  th: number;
  side: "left" | "right";
  accent?: boolean;
}[] = [
  { x: 9, y: 16, kind: "folder", label: "checkout/", th: 0.1, side: "right" },
  { x: 15, y: 42, kind: "file", label: "PR #482", th: 0.28, side: "right" },
  { x: 7, y: 66, kind: "file", label: "LIN-482", th: 0.46, side: "right" },
  { x: 13, y: 86, kind: "folder", label: "migration.md", th: 0.64, side: "right" },
  { x: 91, y: 14, kind: "file", label: "decision · 031", th: 0.19, side: "left" },
  { x: 85, y: 38, kind: "folder", label: "sync · jul 18", th: 0.37, side: "left" },
  { x: 92, y: 62, kind: "file", label: "PaymentForm.tsx", th: 0.55, side: "left" },
  { x: 87, y: 84, kind: "folder", label: "owner · payments", th: 0.92, side: "left", accent: true },
];

function fittedViewBox(g: LensGraph, padding = 55): string {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  g.edges.forEach((edge) => {
    include(edge.x1, edge.y1);
    include(edge.x2, edge.y2);
  });
  g.rings.forEach((node) => {
    include(node.x - node.r, node.y - node.r);
    include(node.x + node.r, node.y + node.r);
  });
  g.dots.forEach((node) => {
    include(node.x - node.r, node.y - node.r);
    include(node.x + node.r, node.y + node.r);
  });
  g.labels.forEach((label) => {
    const width = label.label.length * label.fs * 0.62;
    const left = label.anchor === "middle" ? label.x - width / 2 : label.anchor === "end" ? label.x - width : label.x;
    const right = label.anchor === "middle" ? label.x + width / 2 : label.anchor === "end" ? label.x : label.x + width;
    include(left, label.y - label.fs);
    include(right, label.y + label.fs * 0.4);
  });

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return g.vb;
  return `${(minX - padding).toFixed(1)} ${(minY - padding).toFixed(1)} ${(maxX - minX + padding * 2).toFixed(1)} ${(maxY - minY + padding * 2).toFixed(1)}`;
}

function LensSvg({ g, halo, viewBox = g.vb }: { g: LensGraph; halo: string; viewBox?: string }): JSX.Element {
  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%", display: "block" }} aria-hidden="true">
      {g.edges.map((e, i) => (
        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={e.stroke} strokeWidth={e.w} opacity={e.op} strokeDasharray={e.dash === "none" ? undefined : e.dash} />
      ))}
      {g.rings.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.fill} stroke={n.stroke} strokeWidth={n.sw} strokeDasharray={n.dash === "none" ? undefined : n.dash} />
      ))}
      {g.dots.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.fill} />
      ))}
      {g.labels.map((t, i) => (
        <text
          key={i}
          x={t.x}
          y={t.y}
          textAnchor={t.anchor as "start" | "middle" | "end"}
          style={{ fontFamily: "'Fragment Mono', monospace", fontSize: t.fs, fill: t.fill, fontWeight: t.fw, paintOrder: "stroke", stroke: halo, strokeWidth: 3 }}
        >
          {t.label}
        </text>
      ))}
    </svg>
  );
}

export default function LandingPage(): JSX.Element {
  const [heroSettled, setHeroSettled] = useState(false);
  const heroTreeRef = useRef<HTMLDivElement | null>(null);
  const heroGlowRef = useRef<HTMLDivElement | null>(null);
  const heroContentRef = useRef<HTMLDivElement | null>(null);
  const problemRef = useRef<HTMLElement | null>(null);
  const wordsRef = useRef<HTMLSpanElement[]>([]);
  const decosRef = useRef<HTMLDivElement[]>([]);
  const answerRef = useRef<HTMLDivElement | null>(null);
  const howRef = useRef<HTMLElement | null>(null);
  const drawPathRef = useRef<SVGPathElement | null>(null);
  const drawLenRef = useRef(1);

  useEffect(() => {
    document.title = "sayre_ — your codebase, mapped";
  }, []);

  const problemWords = PROBLEM.body.split(" ");
  // The emphasized noun stays hollow until the surrounding sources resolve.
  const [h2Pre, h2Post] = PROBLEM.h2.split(PROBLEM.emphasis);
  const graphs = lensGraphs();
  const filetreeViewBox = fittedViewBox(graphs.g2);
  const filetreeLens = V2_LENSES.items[1];

  // scroll-driven fx controller (parallax, word scrub, path draw)
  useEffect(() => {
    const reduced = prefersReducedMotion();
    let raf = 0;
    let dead = false;

    if (drawPathRef.current) {
      try {
        drawLenRef.current = drawPathRef.current.getTotalLength();
        drawPathRef.current.style.strokeDasharray = String(drawLenRef.current);
        drawPathRef.current.style.strokeDashoffset = String(reduced ? 0 : drawLenRef.current);
      } catch {
        /* not attached yet */
      }
    }

    // avoid layout thrash: ALL rect reads happen before ANY style writes, every
    // offscreen subsystem is skipped, and words only repaint when they flip
    let lastLit = -1;
    const onScreen = (r: DOMRect, vh: number): boolean => r.bottom > -vh * 0.25 && r.top < vh * 1.25;

    const tick = (): void => {
      if (dead) return;
      const sy = window.scrollY;
      const vh = window.innerHeight;

      // ---- read phase ----
      const problemRect = problemRef.current && wordsRef.current.length ? problemRef.current.getBoundingClientRect() : null;
      const howRect = drawPathRef.current && howRef.current && !reduced ? howRef.current.getBoundingClientRect() : null;

      // ---- write phase ----
      if (!reduced && sy < vh * 1.2) {
        if (heroTreeRef.current) heroTreeRef.current.style.transform = "translateY(" + sy * 0.16 + "px)";
        if (heroGlowRef.current) heroGlowRef.current.style.transform = "translate(-50%,-50%) translateY(" + sy * 0.09 + "px)";
        if (heroContentRef.current) {
          heroContentRef.current.style.transform = "translateY(" + sy * -0.08 + "px)";
          heroContentRef.current.style.opacity = String(Math.max(0, 1 - sy / (vh * 0.72)));
        }
      }

      if (problemRect && onScreen(problemRect, vh)) {
        const p = Math.min(1, Math.max(0, (vh * 0.95 - problemRect.top) / (problemRect.height + vh * 0.25)));
        const scrub = p * 1.25;
        const lit = Math.round(Math.min(wordsRef.current.length, Math.max(0, scrub * wordsRef.current.length)));
        if (lit !== lastLit) {
          // only touch the spans that crossed the boundary since last frame
          const lo = Math.min(lit, lastLit === -1 ? 0 : lastLit);
          const hi = Math.max(lit, lastLit === -1 ? wordsRef.current.length : lastLit);
          for (let i = lo; i < hi; i++) {
            const w = wordsRef.current[i];
            if (!w) continue;
            const on = i < lit;
            w.style.opacity = on ? "1" : "0.16";
            w.style.color = on ? "#E8E6E1" : "#A9A9A0";
            if (!reduced) w.style.transform = on ? "none" : "translateY(6px)";
          }
          lastLit = lit;
        }
        for (const el of decosRef.current) {
          el.classList.toggle("is-on", scrub >= parseFloat(el.dataset.th ?? "1"));
        }
        answerRef.current?.classList.toggle("is-on", scrub >= 1.04);
      }

      if (howRect && onScreen(howRect, vh) && drawPathRef.current) {
        const p = Math.min(1, Math.max(0, (vh * 0.85 - howRect.top) / (howRect.height * 0.9)));
        drawPathRef.current.style.strokeDashoffset = String(drawLenRef.current * (1 - p));
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  const collectWord = (el: HTMLSpanElement | null): void => {
    if (el && !wordsRef.current.includes(el)) wordsRef.current.push(el);
  };
  const collectDeco = (el: HTMLDivElement | null): void => {
    if (el && !decosRef.current.includes(el)) decosRef.current.push(el);
  };
  return (
    <div className="landing-v2">
      {/* ═══ s1 · hero — the tree grows into the graph ═══ */}
      <header className={heroSettled ? "v2-hero is-settled" : "v2-hero"}>
        <div className="v2-hero__scene" ref={heroTreeRef} aria-hidden="true">
          <HeroAnimeVideo onComplete={() => setHeroSettled(true)} />
        </div>
        <div className="v2-hero__glow" ref={heroGlowRef} aria-hidden="true" />
        <div className="v2-hero__vignette" aria-hidden="true" />

        <nav className="v2-nav">
          <span className="wordmark">sayre_</span>
          <div className="v2-nav__right">
            <a className="btn btn--secondary v2-nav__cta" href="#waitlist">
              join the waitlist
            </a>
          </div>
        </nav>

        {heroSettled && (
          <>
            <div className="v2-hero__content" ref={heroContentRef}>
              <Reveal d={0}>
                <span className="v2-eyebrow v2-eyebrow--accent">{V2_HERO.eyebrow}</span>
              </Reveal>
              <Reveal d={1} blur>
                <h1 className="v2-hero__title">{V2_HERO.h1}</h1>
              </Reveal>
            </div>

            <div className="v2-hero__final-cta">
              <a className="btn btn--primary btn--lg btn--glow v2-hero__waitlist-cta" href="#waitlist">
                join the waitlist
              </a>
            </div>

            <div className="v2-scrollhint" aria-hidden="true">
              <span className="v2-scrollhint__label">{V2_HERO.scrollHint}</span>
              <span className="v2-scrollhint__track">
                <span className="v2-scrollhint__drop" />
              </span>
            </div>
          </>
        )}
      </header>

      {/* ═══ s2 · problem — scattered context resolves into a memory graph ═══ */}
      <section className="v2-problem" ref={problemRef}>
        <div className="v2-problem__decos" aria-hidden="true">
          {PROBLEM_DECOS.map((d, i) => (
            <div
              key={i}
              ref={collectDeco}
              data-th={d.th}
              className={[
                "v2-problem__deco",
                d.side === "left" ? "v2-problem__deco--left" : "",
                d.accent ? "v2-problem__deco--accent" : "",
              ].join(" ")}
              style={{ left: `${d.x}%`, top: `${d.y}%` }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" className="v2-problem__deco-glyph">
                {d.kind === "folder" ? (
                  <circle cx="9" cy="9" r="6" fill="none" strokeWidth="1.5" />
                ) : (
                  <circle cx="9" cy="9" r="4.5" strokeWidth="0" />
                )}
              </svg>
              <span className="v2-problem__deco-edge" />
              <span className="v2-problem__deco-label">{d.label}</span>
            </div>
          ))}
        </div>

        <div className="v2-problem__inner">
          <GraphDivider center />
          <h2 className="v2-problem__title">
            {h2Pre}
            <span className="v2-problem__hollow">{PROBLEM.emphasis}</span>
            {h2Post}
          </h2>
          <p className="v2-problem__body">
            {problemWords.map((w, i) => (
              // the space lives OUTSIDE the span — inline-block would swallow it
              <span key={i}>
                <span ref={collectWord} className="v2-problem__word">
                  {w}
                </span>{" "}
              </span>
            ))}
          </p>
          <div className="v2-problem__answer" ref={answerRef} aria-hidden="true">
            <svg width="30" height="10" viewBox="0 0 30 10">
              <line x1="0" y1="5" x2="20" y2="5" stroke="#4F7F5D" strokeWidth="1.5" />
              <circle cx="25" cy="5" r="3.5" fill="#4F7F5D" />
            </svg>
            PaymentForm.tsx · PR #482 · LIN-482 · decision linked
          </div>
        </div>
      </section>

      {/* ═══ s3 · agent-human context carried by the graph ═══ */}
      <section className="v2-layers">
        <Reveal d={0}>
          <span className="v2-eyebrow">{V2_LAYERS.eyebrow}</span>
        </Reveal>
        <Reveal d={1}>
          <h2 className="v2-h2 v2-layers__title">{V2_LAYERS.h2}</h2>
        </Reveal>
        <Reveal d={2}>
          <div className="v2-grid">
            <div className="v2-cell">
              <div className="v2-cell__kind">tests</div>
              <div className="v2-cell__lead v2-cell__lead--fail">failing</div>
              <div className="v2-cell__mono">useCheckout.test.ts</div>
              <p>promo-merge case times out since the guest-cart merge landed</p>
            </div>
            <div className="v2-cell">
              <div className="v2-cell__kind">owners</div>
              <div className="v2-cell__lead">checkout/</div>
              <div className="v2-cell__mono">dana park · miguel reyes</div>
              <p>ownership read from history, not a stale CODEOWNERS</p>
            </div>
            <div className="v2-cell">
              <div className="v2-cell__kind">tickets</div>
              <div className="v2-cell__ticket">
                <span className="chip">LIN-482</span>
                <span className="v2-cell__faint">in progress</span>
              </div>
              <p>stripe payment-intent migration — pinned to the four files it touches</p>
            </div>
            <div className="v2-cell">
              <div className="v2-cell__kind">recent changes</div>
              <p className="v2-cell__bright">migrate PaymentForm to payment intents</p>
              <div className="v2-cell__faintmono">a1b2c3f · dana park · 2d ago · pr #482</div>
            </div>
            <div className="v2-cell v2-cell--wide">
              <div className="v2-cell__kind">agent / skill md · scoped to acme/</div>
              <div className="v2-cell__md">
                — pnpm workspaces; never npm install inside a package
                <br />— shared logic lives in packages/ — apps import it, never each other
                <br />— money is integer minor units everywhere
              </div>
            </div>
            <div className="v2-cell">
              <div className="v2-cell__kind">dependencies</div>
              <div className="v2-cell__lead">stripe cli</div>
              <div className="v2-cell__cmd">stripe listen --forward-to localhost:3000</div>
            </div>
            <div className="v2-cell">
              <div className="v2-cell__kind">relations</div>
              <div className="v2-cell__lead">currency.ts</div>
              <div className="v2-cell__mono">6 in · 1 out</div>
              <p>six importers across web, api, and the indexer — breaking changes announce themselves</p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ═══ s4 · standalone filetree ═══ */}
      <section className="v2-filetree" aria-labelledby="filetree-title">
        <Reveal d={0}>
          <div className="v2-filetree__intro">
            <div>
              <span className="v2-eyebrow v2-eyebrow--accent">{filetreeLens.eyebrow}</span>
              <h2 className="v2-filetree__title" id="filetree-title">
                {filetreeLens.h3}
              </h2>
            </div>
            <p className="v2-filetree__body">{filetreeLens.body}</p>
          </div>
        </Reveal>
        <Reveal d={1}>
          <div
            className="v2-filetree__stage"
            role="img"
            aria-label="Filetree graph centered on apps/web/src/checkout/PaymentForm.tsx"
          >
            <div className="v2-filetree__glow" aria-hidden="true" />
            <div className="v2-filetree__graph">
              <LensSvg g={graphs.g2} halo="#0D0E0C" viewBox={filetreeViewBox} />
            </div>
          </div>
        </Reveal>
      </section>

      {/* ═══ s5 · feature deck — reader-controlled, no scroll capture ═══ */}
      <FeatureDeck />

      {/* ═══ s6 · how it works — diagonal cascade; step cards sit clear of the path ═══ */}
      <section className="v2-how" ref={howRef}>
        <Reveal d={0}>
          <span className="v2-eyebrow">{V2_HOW.eyebrow}</span>
        </Reveal>
        <Reveal d={1}>
          <h2 className="v2-h2 v2-how__title">{V2_HOW.h2}</h2>
        </Reveal>
        <div className="v2-how__stage">
          <svg viewBox="0 0 1160 700" preserveAspectRatio="none" aria-hidden="true" className="v2-how__path">
            <path d="M 60 46 L 350 46 L 470 260 L 700 260 L 820 474 L 1080 474" className="v2-how__path-base" />
            <path ref={drawPathRef} d="M 60 46 L 350 46 L 470 260 L 700 260 L 820 474 L 1080 474" className="v2-how__path-draw" />
            <circle cx="60" cy="46" r="6.5" className="v2-how__node" />
            <circle cx="470" cy="260" r="6.5" className="v2-how__node" />
            <circle cx="820" cy="474" r="6.5" className="v2-how__node" />
            <circle cx="1080" cy="474" r="4.5" className="v2-how__dot" />
          </svg>
          {HOW_IT_WORKS.rows.map((row, i) => (
            <Reveal key={row.num} d={i}>
              {/* cards sit below their path segment (relocated so lines never strike through) */}
              <div className={`v2-how__step v2-how__step--${i + 1}`}>
                <span className="v2-how__num">{row.num}</span>
                <div>
                  <h3>{row.h3}</h3>
                  <p>{row.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ═══ conversion footer · waitlist finale ═══ */}
      <section className="v2-waitlist" id="waitlist">
        <div className="v2-waitlist__glow" aria-hidden="true" />
        <div className="v2-waitlist__inner">
          <Reveal d={0}>
            <div className="v2-waitlist__ring" aria-hidden="true" />
          </Reveal>
          <Reveal d={1}>
            <h2 className="v2-waitlist__title">{WAITLIST_BAND.h2}</h2>
          </Reveal>
          <Reveal d={2}>
            <p className="v2-waitlist__body">{WAITLIST_BAND.body}</p>
          </Reveal>
          <Reveal d={3}>
            <div className="v2-waitlist__form">
              <WaitlistForm source="landing" />
            </div>
          </Reveal>
          <p className="v2-waitlist__fine">
            {WAITLIST_BAND.fine} · <Link to="/privacy">privacy policy</Link>
          </p>
        </div>
        <footer className="v2-footer">
          <span className="wordmark">sayre_</span>
          <span className="v2-footer__links">
            <Link to="/privacy">privacy</Link>
            <a href={`mailto:${CONTACT_EMAIL}`}>contact</a>
          </span>
          <span className="v2-footer__legal">
            <span>We do not sell or share personal information.</span>
            <span>© 2026 sayre</span>
          </span>
        </footer>
      </section>
    </div>
  );
}
