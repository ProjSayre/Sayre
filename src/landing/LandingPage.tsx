import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { CONTACT_EMAIL } from "../config";
import { NODE_BY_ID, SUGGESTED_FILES } from "../data";
import { HOW_IT_WORKS, PROBLEM, V2_FRAME, V2_HERO, V2_HOW, V2_LAYERS, V2_LENSES, WAITLIST_BAND } from "../data/copy";
import { prefersReducedMotion } from "../demo/canvas/useCamera";
import { WaitlistForm } from "../shared/WaitlistForm";
import { HeroTreeAmbient } from "./HeroTreeScene";
import { lensGraphs } from "./lensGraphs";
import type { LensGraph } from "./lensGraphs";
import { GraphDivider, Reveal } from "./Reveal";

const GLOW = 0.65;

function LensSvg({ g, halo }: { g: LensGraph; halo: string }): JSX.Element {
  return (
    <svg viewBox={g.vb} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%", display: "block" }} aria-hidden="true">
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
  const heroTreeRef = useRef<HTMLDivElement | null>(null);
  const heroGlowRef = useRef<HTMLDivElement | null>(null);
  const heroContentRef = useRef<HTMLDivElement | null>(null);
  const problemRef = useRef<HTMLElement | null>(null);
  const wordsRef = useRef<HTMLSpanElement[]>([]);
  const pinRef = useRef<HTMLDivElement | null>(null);
  const lensTextsRef = useRef<HTMLDivElement[]>([]);
  const lensGraphsRef = useRef<HTMLDivElement[]>([]);
  const lensCountRef = useRef<HTMLDivElement | null>(null);
  const howRef = useRef<HTMLElement | null>(null);
  const drawPathRef = useRef<SVGPathElement | null>(null);
  const drawLenRef = useRef(1);
  const frameGlowRef = useRef<HTMLDivElement | null>(null);
  const frameHoverRef = useRef(false);

  useEffect(() => {
    document.title = "sayre_ — your codebase, mapped";
  }, []);

  const problemWords = PROBLEM.body.split(" ");
  const graphs = lensGraphs();
  const paymentForm = NODE_BY_ID.get("apps/web/src/checkout/PaymentForm.tsx");

  // scroll-driven fx controller (parallax, word scrub, lens phase, path draw, sweep)
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

    const setLensPhase = (p: number): void => {
      const n = 3;
      const vis = (i: number): number => {
        const c = i / (n - 1);
        return Math.max(0, 1 - Math.abs(p - c) * (n - 1) * 2.2);
      };
      lensTextsRef.current.forEach((el) => {
        const i = parseInt(el.dataset.i ?? "0", 10);
        const v = vis(i);
        el.style.opacity = String(v);
        el.style.visibility = v < 0.05 ? "hidden" : "visible";
        el.style.transform = reduced ? "none" : "translateY(" + (p - i / (n - 1)) * -46 + "px)";
        el.style.pointerEvents = v > 0.5 ? "auto" : "none";
      });
      lensGraphsRef.current.forEach((el) => {
        const i = parseInt(el.dataset.i ?? "0", 10);
        const v = vis(i);
        el.style.opacity = String(v);
        el.style.visibility = v < 0.05 ? "hidden" : "visible";
        el.style.transform = reduced ? "none" : "scale(" + (0.94 + v * 0.06) + ")";
      });
      if (lensCountRef.current) {
        const idx = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
        lensCountRef.current.textContent = "0" + (idx + 1) + " / 03";
      }
    };

    const tick = (ts: number): void => {
      if (dead) return;
      const sy = window.scrollY;
      const vh = window.innerHeight;

      if (!reduced && sy < vh * 1.2) {
        if (heroTreeRef.current) heroTreeRef.current.style.transform = "translateY(" + sy * 0.16 + "px)";
        if (heroGlowRef.current) heroGlowRef.current.style.transform = "translate(-50%,-50%) translateY(" + sy * 0.09 + "px)";
        if (heroContentRef.current) {
          heroContentRef.current.style.transform = "translateY(" + sy * -0.08 + "px)";
          heroContentRef.current.style.opacity = String(Math.max(0, 1 - sy / (vh * 0.72)));
        }
      }

      if (problemRef.current && wordsRef.current.length) {
        const r = problemRef.current.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (vh * 0.8 - r.top) / (r.height + vh * 0.25)));
        const lit = p * 1.25 * wordsRef.current.length;
        wordsRef.current.forEach((w, i) => {
          const on = i < lit;
          w.style.opacity = on ? "1" : "0.16";
          w.style.color = on ? "#E8E6E1" : "#A9A9A0";
        });
      }

      if (pinRef.current) {
        const r = pinRef.current.getBoundingClientRect();
        const total = r.height - vh;
        const p = Math.min(1, Math.max(0, -r.top / total));
        setLensPhase(p);
      }

      if (drawPathRef.current && howRef.current && !reduced) {
        const r = howRef.current.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (vh * 0.85 - r.top) / (r.height * 0.9)));
        drawPathRef.current.style.strokeDashoffset = String(drawLenRef.current * (1 - p));
      }

      if (frameGlowRef.current) {
        if (reduced) {
          frameGlowRef.current.style.background = "#262723";
        } else {
          const hov = frameHoverRef.current ? 1 : 0.45;
          const a = (ts * 0.03) % 360;
          frameGlowRef.current.style.background =
            "conic-gradient(from " + a + "deg at 50% 50%, rgba(79,127,93,0) 0deg, rgba(116,165,131," + 0.75 * hov * GLOW + ") 24deg, rgba(79,127,93,0) 70deg), #262723";
        }
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
  const collectLensText = (el: HTMLDivElement | null): void => {
    if (el && !lensTextsRef.current.includes(el)) lensTextsRef.current.push(el);
  };
  const collectLensGraph = (el: HTMLDivElement | null): void => {
    if (el && !lensGraphsRef.current.includes(el)) lensGraphsRef.current.push(el);
  };

  return (
    <div className="landing-v2">
      {/* ═══ s1 · hero — the tree grows into the graph ═══ */}
      <header className="v2-hero">
        <div className="v2-hero__scene" ref={heroTreeRef} aria-hidden="true">
          <HeroTreeAmbient />
        </div>
        <div className="v2-hero__glow" ref={heroGlowRef} aria-hidden="true" />
        <div className="v2-hero__vignette" aria-hidden="true" />

        <nav className="v2-nav">
          <span className="wordmark">sayre_</span>
          <div className="v2-nav__right">
            <Link className="v2-nav__demo" to="/demo">
              demo
            </Link>
            <a className="btn btn--primary btn--glow v2-nav__cta" href="#waitlist">
              get early access
            </a>
          </div>
        </nav>

        <div className="v2-hero__content" ref={heroContentRef}>
          <Reveal d={0}>
            <span className="v2-eyebrow v2-eyebrow--accent">{V2_HERO.eyebrow}</span>
          </Reveal>
          <Reveal d={1} blur>
            <h1 className="v2-hero__title">{V2_HERO.h1}</h1>
          </Reveal>
          <Reveal d={2}>
            <div className="v2-hero__ctas">
              <Link to="/demo" className="btn btn--primary btn--lg btn--glow">
                {V2_HERO.cta}
              </Link>
            </div>
          </Reveal>
        </div>

        <div className="v2-scrollhint" aria-hidden="true">
          <span className="v2-scrollhint__label">{V2_HERO.scrollHint}</span>
          <span className="v2-scrollhint__track">
            <span className="v2-scrollhint__drop" />
          </span>
        </div>
      </header>

      {/* ═══ s2 · problem — rest beat with per-word illumination ═══ */}
      <section className="v2-problem" ref={problemRef}>
        <GraphDivider center />
        <h2 className="v2-problem__title">{PROBLEM.h2}</h2>
        <p className="v2-problem__body">
          {problemWords.map((w, i) => (
            <span key={i} ref={collectWord} className="v2-problem__word">
              {w}{" "}
            </span>
          ))}
        </p>
      </section>

      {/* ═══ s3 · pinned split-viewport — one graph, three lenses ═══ */}
      <div className="v2-pin" ref={pinRef}>
        <div className="v2-pin__sticky">
          <div className="v2-pin__grid">
            <div>
              <span className="v2-eyebrow">{V2_LENSES.eyebrow}</span>
              <h2 className="v2-h2">{V2_LENSES.h2}</h2>
              <div className="v2-pin__count" ref={lensCountRef}>
                01 / 03
              </div>
              <div className="v2-pin__texts">
                {V2_LENSES.items.map((item, i) => (
                  <div key={i} className="v2-pin__text" data-i={i} ref={collectLensText}>
                    <span className="v2-eyebrow v2-eyebrow--accent">{item.eyebrow}</span>
                    <h3>{item.h3}</h3>
                    <p>{item.body}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="v2-pin__stage">
              <div className="v2-pin__stage-glow" aria-hidden="true" />
              {[graphs.g1, graphs.g2, graphs.g3].map((g, i) => (
                <div key={i} className="v2-pin__graph" data-i={i} ref={collectLensGraph}>
                  <LensSvg g={g} halo="#0D0E0C" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ s4 · the demo, framed in light ═══ */}
      <section className="v2-frame-section">
        <div className="v2-frame-head">
          <Reveal d={0}>
            <span className="v2-eyebrow">{V2_FRAME.eyebrow}</span>
          </Reveal>
          <Reveal d={1}>
            <h2 className="v2-h2">{V2_FRAME.h2}</h2>
          </Reveal>
          <Reveal d={2}>
            <p className="v2-frame-head__body">{V2_FRAME.body}</p>
          </Reveal>
        </div>
        <Reveal d={1}>
          <div className="v2-frame-wrap">
            <div className="v2-frame-underglow" aria-hidden="true" />
            <Link
              to="/demo"
              className="v2-frame-link"
              aria-label="open the live demo"
              onMouseEnter={() => {
                frameHoverRef.current = true;
              }}
              onMouseLeave={() => {
                frameHoverRef.current = false;
              }}
            >
              <div className="v2-frame-glow" ref={frameGlowRef}>
                <div className="v2-frame">
                  <div className="v2-frame__chrome">
                    <div className="v2-frame__brandrow">
                      <span className="v2-frame__wordmark">sayre_</span>
                      <span className="v2-frame__repo">acme/monorepo</span>
                      <span className="v2-frame__meta">main · 1,204 files · synced 2m ago</span>
                      <span className="v2-frame__segments">
                        <span>new hire</span>
                        <span className="is-active">tech lead</span>
                        <span>pm</span>
                      </span>
                    </div>
                    <div className="v2-frame__tabrow">
                      <span className="v2-frame__tab is-active">
                        <span className="v2-frame__tabdot" />
                        filetree
                      </span>
                      <span className="v2-frame__tab">features</span>
                      <span className="v2-frame__tab">relations</span>
                      <span className="v2-frame__crumb">acme/ › apps/ › web/ › src/ › checkout/</span>
                    </div>
                  </div>
                  <div className="v2-frame__body">
                    <div className="v2-frame__panel">
                      <div className="v2-frame__paneltabs">
                        <span>tree</span>
                        <span className="is-active">search</span>
                      </div>
                      <div className="v2-frame__searchbox">
                        <span className="v2-frame__searchtext">
                          payment<span className="v2-frame__caret">|</span>
                        </span>
                        <span className="v2-frame__searchhint">⌘k</span>
                      </div>
                      <div className="v2-frame__results">
                        {SUGGESTED_FILES.slice(0, 5).map((id, i) => {
                          const n = NODE_BY_ID.get(id);
                          return (
                            <div key={id} className={i === 0 ? "v2-frame__result is-active" : "v2-frame__result"}>
                              <span className="v2-frame__resultname">{n?.name ?? id}</span>
                              <span className="v2-frame__resultpath">{id}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="v2-frame__canvas">
                      <LensSvg g={graphs.g2} halo="#131412" />
                      <div className="v2-frame__status">zoom 100% · tree layout · depth 6 · sample data</div>
                    </div>
                    <div className="v2-frame__inspector">
                      <div className="v2-frame__path">
                        checkout/<span>PaymentForm.tsx</span>
                      </div>
                      <div className="v2-frame__stat">
                        tsx · 214 loc · <span className="v2-frame__pass">passing</span>
                      </div>
                      <p className="v2-frame__desc">{paymentForm?.meta.description?.split(".")[0]}.</p>
                      <div className="v2-frame__change">a1b2c3f · dana park · 2d ago</div>
                    </div>
                  </div>
                </div>
              </div>
              <span className="v2-frame__chip">{V2_FRAME.chip}</span>
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ═══ s5 · how it works — diagonal cascade; step cards sit clear of the path ═══ */}
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

      {/* ═══ s6 · density moment — what the graph carries ═══ */}
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

      {/* ═══ s7 · waitlist finale — a single node blooming ═══ */}
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
              <WaitlistForm source="landing" compact />
            </div>
          </Reveal>
          <p className="v2-waitlist__fine">{WAITLIST_BAND.fine}</p>
        </div>
        <footer className="v2-footer">
          <span className="wordmark">sayre_</span>
          <span className="v2-footer__links">
            <Link to="/demo">demo</Link>
            <a href={`mailto:${CONTACT_EMAIL}`}>contact</a>
          </span>
          <span className="v2-footer__copyright">© 2026 sayre</span>
        </footer>
      </section>
    </div>
  );
}
