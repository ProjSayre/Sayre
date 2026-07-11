import { useEffect } from "react";
import { Link } from "react-router-dom";
import { CONTACT_EMAIL } from "../config";
import { HERO, HOW_IT_WORKS, LENSES, PROBLEM, WAITLIST_BAND } from "../data/copy";
import { Button } from "../shared/Button";
import { WaitlistForm } from "../shared/WaitlistForm";
import { DeepDives } from "./DeepDives";
import { GraphDivider, Reveal } from "./Reveal";
import { Teaser } from "./Teaser";

/** the three lenses drawn in the product's own node language */
function LensGlyph({ kind }: { kind: "new hire" | "tech lead" | "product manager" }): JSX.Element {
  if (kind === "new hire") {
    // relations: three siblings, solid outgoing + dashed incoming
    return (
      <svg className="lens-glyph" width="72" height="44" viewBox="0 0 72 44" aria-hidden="true">
        <line x1="14" y1="12" x2="56" y2="12" stroke="var(--accent)" strokeWidth="1.5" />
        <line x1="20" y1="34" x2="52" y2="16" stroke="var(--accent)" strokeWidth="1" strokeDasharray="4 3" />
        <circle cx="12" cy="12" r="6" fill="var(--bg)" stroke="var(--node-stroke)" strokeWidth="1.5" />
        <circle cx="58" cy="12" r="6" fill="var(--bg)" stroke="var(--accent)" strokeWidth="1.5" />
        <circle cx="16" cy="36" r="6" fill="var(--bg)" stroke="var(--node-stroke)" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === "tech lead") {
    // filetree: root → dir → file with a lit path and a failing badge
    return (
      <svg className="lens-glyph" width="72" height="44" viewBox="0 0 72 44" aria-hidden="true">
        <line x1="36" y1="8" x2="16" y2="36" stroke="var(--edge)" strokeWidth="1" />
        <line x1="36" y1="8" x2="56" y2="36" stroke="var(--accent)" strokeWidth="1.5" />
        <circle cx="36" cy="8" r="6" fill="var(--bg)" stroke="var(--text-muted)" strokeWidth="1.5" />
        <circle cx="16" cy="36" r="4" fill="var(--node-stroke)" />
        <circle cx="56" cy="36" r="4.5" fill="var(--accent)" />
        <circle cx="62" cy="29" r="2" fill="var(--test-fail)" />
      </svg>
    );
  }
  // product manager: dashed feature ring holding a dir + files
  return (
    <svg className="lens-glyph" width="72" height="44" viewBox="0 0 72 44" aria-hidden="true">
      <circle cx="26" cy="22" r="18" fill="var(--bg)" stroke="var(--node-stroke)" strokeWidth="1" strokeDasharray="5 3" />
      <circle cx="22" cy="16" r="4.5" fill="var(--bg)" stroke="var(--node-stroke)" strokeWidth="1.25" />
      <circle cx="31" cy="27" r="2.5" fill="var(--node-stroke)" />
      <circle cx="24" cy="30" r="2.5" fill="var(--node-stroke)" />
      <circle cx="33" cy="18" r="2.5" fill="var(--accent)" />
      <line x1="46" y1="22" x2="60" y2="22" stroke="var(--edge)" strokeWidth="1" />
      <circle cx="64" cy="22" r="3" fill="var(--node-stroke)" />
    </svg>
  );
}

export default function LandingPage(): JSX.Element {
  useEffect(() => {
    document.title = "sayre_ — your codebase, mapped";
  }, []);

  const scrollToWaitlist = (): void => {
    document.getElementById("waitlist")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="landing">
      <nav className="landing-nav">
        <span className="wordmark">sayre_</span>
        <div className="landing-nav__right">
          <Link className="landing-nav__demo" to="/demo">
            demo
          </Link>
          <Button small onClick={scrollToWaitlist}>
            get early access
          </Button>
        </div>
      </nav>

      {/* §1 hero — staggered entrance via css */}
      <header className="hero">
        <span className="eyebrow">{HERO.eyebrow}</span>
        <h1 className="hero__title">{HERO.h1}</h1>
        <p className="hero__sub">{HERO.sub}</p>
        <div className="hero__ctas">
          <Link to="/demo" className="btn btn--primary btn--lg">
            {HERO.ctaPrimary}
          </Link>
          <button className="btn btn--secondary btn--lg" onClick={scrollToWaitlist}>
            {HERO.ctaSecondary}
          </button>
        </div>
        <Teaser />
      </header>

      {/* §2 problem line */}
      <section className="problem">
        <Reveal>
          <GraphDivider />
          <h2>{PROBLEM.h2}</h2>
          <p>{PROBLEM.body}</p>
        </Reveal>
      </section>

      {/* §3 lenses */}
      <section className="lenses">
        <Reveal>
          <GraphDivider />
          <h2>{LENSES.h2}</h2>
        </Reveal>
        <div className="lenses__grid">
          {LENSES.cards.map((card, i) => (
            <Reveal key={card.h3} delay={i * 90}>
              <div className="lens-card">
                <LensGlyph kind={card.h3 as "new hire" | "tech lead" | "product manager"} />
                <span className="eyebrow">{card.eyebrow}</span>
                <h3>{card.h3}</h3>
                <p>{card.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* §4 how it works */}
      <section className="how">
        <Reveal>
          <GraphDivider />
          <h2>{HOW_IT_WORKS.h2}</h2>
        </Reveal>
        <div className="how__rows">
          {HOW_IT_WORKS.rows.map((row, i) => (
            <Reveal key={row.num} delay={i * 90}>
              <div className="how__row">
                <span className="how__num">{row.num}</span>
                <div>
                  <h3>{row.h3}</h3>
                  <p>{row.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* §5 view deep-dives */}
      <DeepDives />

      {/* §6 waitlist band */}
      <section className="waitlist-band" id="waitlist">
        <Reveal>
          <GraphDivider />
          <h2>{WAITLIST_BAND.h2}</h2>
          <p>{WAITLIST_BAND.body}</p>
          <WaitlistForm source="landing" />
          <p className="waitlist-band__fine">{WAITLIST_BAND.fine}</p>
        </Reveal>
      </section>

      {/* §7 footer */}
      <footer className="footer">
        <span className="wordmark">sayre_</span>
        <span className="footer__links">
          <Link to="/demo">demo</Link>
          <a href={`mailto:${CONTACT_EMAIL}`}>contact</a>
        </span>
        <span className="footer__copyright">© 2026 sayre</span>
      </footer>
    </div>
  );
}
