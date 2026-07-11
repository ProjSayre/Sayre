import { DEEP_DIVES } from "../data/copy";
import { FeaturesView } from "../demo/canvas/FeaturesView";
import { FiletreeView } from "../demo/canvas/FiletreeView";
import { RelationsView } from "../demo/canvas/RelationsView";
import { CanvasSandbox } from "./CanvasSandbox";
import { GraphDivider, Reveal } from "./Reveal";

const PAYMENT_FORM = "apps/web/src/checkout/PaymentForm.tsx";

/** §11 §5 — static renders of the actual canvas components with curated state */
export function DeepDives(): JSX.Element {
  return (
    <section className="deepdives">
      {DEEP_DIVES.map((dive, i) => (
        <Reveal key={dive.view}>
          <div className={i % 2 === 1 ? "deepdive deepdive--flip" : "deepdive"}>
            <div className="deepdive__media" aria-hidden="true">
              <CanvasSandbox
                setup={(s) => {
                  if (dive.view === "filetree") return { ...s, selectedId: PAYMENT_FORM };
                  if (dive.view === "features")
                    return { ...s, tab: "features", selectedFeatureId: "checkout" };
                  return { ...s, tab: "relations", relationsScope: "apps", selectedId: "apps/api" };
                }}
              >
                {dive.view === "filetree" && <FiletreeView interactive={false} />}
                {dive.view === "features" && <FeaturesView interactive={false} />}
                {dive.view === "relations" && <RelationsView interactive={false} />}
              </CanvasSandbox>
            </div>
            <div className="deepdive__copy">
              <GraphDivider />
              <span className="eyebrow">{dive.view}</span>
              <h3>{dive.h3}</h3>
              <p>{dive.body}</p>
            </div>
          </div>
        </Reveal>
      ))}
    </section>
  );
}
