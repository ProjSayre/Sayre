import type { Persona } from "./types";

export const PERSONAS: Persona[] = [
  {
    id: "new-hire",
    label: "new hire",
    defaultTab: "relations",
    layers: ["description", "dependencies", "agentMd"],
  },
  {
    id: "tech-lead",
    label: "tech lead",
    defaultTab: "filetree",
    layers: ["description", "recentChanges", "features", "tests"],
  },
  {
    id: "pm",
    label: "product manager",
    defaultTab: "features",
    layers: ["description", "features", "tickets"],
  },
];
