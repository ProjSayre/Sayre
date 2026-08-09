export interface PitchSummary {
  features: readonly {
    id: string;
    name: string;
    description: string | null;
    team: string | null;
    files: readonly string[];
    recentChanges: readonly string[];
  }[];
}

export function PitchSummaryPanel({ summary }: { summary: PitchSummary }) {
  return (
    <aside aria-label="Pitch summary">
      <h2>Product at a glance</h2>
      <p>{summary.features.length} mapped features</p>
      {summary.features.map((feature) => (
        <article key={feature.id}>
          <h3>{feature.name}</h3>
          <p>{feature.description ?? 'Description is still being generated.'}</p>
          <p>Team: {feature.team ?? 'Unassigned'}</p>
          <p>Files: {feature.files.length === 0 ? 'None visible' : feature.files.join(', ')}</p>
          <ul>{feature.recentChanges.map((change) => <li key={change}>{change}</li>)}</ul>
        </article>
      ))}
    </aside>
  );
}
