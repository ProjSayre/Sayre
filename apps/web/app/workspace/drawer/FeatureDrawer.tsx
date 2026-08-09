'use client';

import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceQueries, useWorkspaceSelection } from '../state';
import { buildProductFeatureConnections } from '../canvas/productGraph';
import { isStructuralEdge } from '../types';
import { EmptyState, Module, formatTimestamp } from '../components/ui';

type FeatureDrawerTab = 'description' | 'connections' | 'files' | 'activity';

const FEATURE_DRAWER_TABS: Array<{
  id: FeatureDrawerTab;
  label: string;
}> = [
  { id: 'description', label: 'Description' },
  { id: 'connections', label: 'Links' },
  { id: 'files', label: 'Files' },
  { id: 'activity', label: 'Activity' },
];

function codeArea(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  if (
    (parts[0] === 'apps' ||
      parts[0] === 'packages' ||
      parts[0] === 'services') &&
    parts[1] !== undefined
  ) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? '(repository root)';
}

export function FeatureDrawer() {
  const { graph, graphStatus } = useWorkspaceQueries();
  const selection = useWorkspaceSelection();
  const [activeTab, setActiveTab] =
    useState<FeatureDrawerTab>('description');
  const feature = graph.features.find(
    (item) => item.id === selection.selectedFeatureId,
  );
  useEffect(() => {
    setActiveTab('description');
  }, [feature?.id]);
  const featureFiles = useMemo(
    () =>
      feature === undefined
        ? []
        : feature.memberIds
            .map((fileId) =>
              graph.nodes.find((node) => node.id === fileId),
            )
            .filter((file): file is (typeof graph.nodes)[number] =>
              Boolean(file),
            ),
    [feature, graph],
  );
  const relatedFeatures = useMemo(() => {
    if (feature === undefined) return [];
    return buildProductFeatureConnections(
      graph.features,
      graph.edges.filter(isStructuralEdge),
    )
      .flatMap((connection) => {
        const selectedIsSource = connection.sourceFeatureId === feature.id;
        const selectedIsTarget = connection.targetFeatureId === feature.id;
        if (!selectedIsSource && !selectedIsTarget) return [];
        const relatedId = selectedIsSource
          ? connection.targetFeatureId
          : connection.sourceFeatureId;
        const related = graph.features.find(
          (candidate) => candidate.id === relatedId,
        );
        if (related === undefined) return [];
        const outgoingCount = selectedIsSource
          ? connection.sourceToTargetDependencyCount
          : connection.targetToSourceDependencyCount;
        const incomingCount = selectedIsSource
          ? connection.targetToSourceDependencyCount
          : connection.sourceToTargetDependencyCount;
        return [
          {
            feature: related,
            relation:
              outgoingCount > 0 && incomingCount > 0
                ? `Mapped code imports flow both ways (${outgoingCount + incomingCount})`
                : outgoingCount > 0
                  ? `${feature.name} imports ${related.name} code (${outgoingCount})`
                  : incomingCount > 0
                    ? `${related.name} imports ${feature.name} code (${incomingCount})`
                    : `${connection.sharedFileIds.length} shared mapped ${
                        connection.sharedFileIds.length === 1 ? 'file' : 'files'
                      }`,
          },
        ];
      })
      .sort((left, right) =>
        left.feature.name.localeCompare(right.feature.name),
      );
  }, [feature, graph]);

  if (feature === undefined) {
    if (graphStatus !== 'loading') return null;
    return (
      <aside className="mock-drawer" aria-label="Opening feature details">
        <div className="mock-drawer-header">
          <div className="mock-drawer-heading">
            <span className="mock-drawer-kind">Product Tree</span>
            <h2>Opening feature context…</h2>
            <p className="mock-drawer-path">
              Loading the inferred feature map.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const codeAreas = [...new Set(featureFiles.map((file) => codeArea(file.path)))];
  const firstFile = featureFiles[0];

  return (
    <aside className="mock-drawer" aria-label={`Details for ${feature.name}`}>
      <div className="mock-drawer-header">
        <div className="mock-drawer-heading">
          <span className="mock-drawer-kind">AI-inferred feature</span>
          <h2>{feature.name}</h2>
          <p className="mock-drawer-path">
            Owned by {feature.team ?? 'an unassigned team'}
          </p>
        </div>
        <div className="mock-drawer-header-actions">
          {firstFile !== undefined && (
            <button
              type="button"
              className="mock-btn mock-btn-ghost mock-btn-sm"
              onClick={() => selection.openNodeInTechnicalView(firstFile.id)}
            >
              Explore code →
            </button>
          )}
          <button
            type="button"
            className="mock-btn mock-btn-ghost"
            aria-label="Close details"
            onClick={selection.closeInspector}
          >
            ✕
          </button>
        </div>
      </div>

      <div
        className="mock-drawer-tabs"
        role="tablist"
        aria-label={`${feature.name} details`}
      >
        {FEATURE_DRAWER_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`feature-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`feature-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id={`feature-panel-${activeTab}`}
        className="mock-drawer-scroll"
        role="tabpanel"
        aria-labelledby={`feature-tab-${activeTab}`}
      >
        {activeTab === 'description' && (
          <>
            <Module title="Description">
              <p className="mock-prose">
                {feature.description ??
                  'No feature description is available yet.'}
              </p>
              <p className="mock-module-note mock-module-note-spaced">
                This boundary is inferred from the current authorized ref. Treat
                it as a navigational model, not a permanent product taxonomy.
              </p>
            </Module>

            <Module title="At a glance">
              <dl className="mock-summary-grid mock-summary-grid-spaced">
                <div>
                  <dt>Identified files</dt>
                  <dd>{featureFiles.length.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Code areas</dt>
                  <dd>{codeAreas.length.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Feature links</dt>
                  <dd>{relatedFeatures.length.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Recent activity</dt>
                  <dd>
                    {feature.recentEdits.length > 0
                      ? feature.recentEdits.length.toLocaleString()
                      : 'Unknown'}
                  </dd>
                </div>
              </dl>
              {codeAreas.length > 0 && (
                <div
                  className="mock-scope-chips"
                  aria-label="Feature code areas"
                >
                  {codeAreas.map((area) => (
                    <span key={area} className="mock-chip">
                      {area}
                    </span>
                  ))}
                </div>
              )}
            </Module>
          </>
        )}

        {activeTab === 'connections' && (
          <Module
            title="Detected feature links"
            count={relatedFeatures.length}
          >
            {relatedFeatures.length === 0 ? (
              <EmptyState>
                No mapped cross-feature code links were detected. This does not
                prove the feature is independent; unmapped code is excluded.
              </EmptyState>
            ) : (
              <>
                <p className="mock-module-note">
                  Links summarize imports between mapped files. Select a related
                  feature to inspect its scope.
                </p>
                <ul className="mock-list">
                  {relatedFeatures.map(({ feature: related, relation }) => (
                    <li key={related.id}>
                      <button
                        type="button"
                        className="mock-list-row"
                        onClick={() => selection.selectFeature(related.id)}
                      >
                        <span className="mock-row-top">
                          <span className="mock-row-title">{related.name}</span>
                          <span className="mock-chip">
                            {related.team ?? 'Unassigned'}
                          </span>
                        </span>
                        <span className="mock-row-sub mock-row-wrap">
                          {relation}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Module>
        )}

        {activeTab === 'files' && (
          <Module title="Identified files" count={featureFiles.length}>
            <p className="mock-module-note">
              These are the files Sayre assigned to this feature, not
              necessarily its complete implementation.
            </p>
            <ul className="mock-list">
              {featureFiles.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className="mock-list-row"
                    onClick={() => selection.selectNode(file.id)}
                  >
                    <span className="mock-row-top">
                      <span className="mock-row-title">{file.name}</span>
                      <span className="mock-chip">{file.kind}</span>
                    </span>
                    <span className="mock-row-sub">{file.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Module>
        )}

        {activeTab === 'activity' && (
          <Module title="Recent edits" count={feature.recentEdits.length}>
            {feature.recentEdits.length === 0 ? (
              <EmptyState>
                No activity data has been ingested for this feature. Delivery
                status and risk are unknown.
              </EmptyState>
            ) : (
              <ul className="mock-list">
                {feature.recentEdits.map((edit) => (
                  <li
                    key={`${edit.filePath}:${edit.editedAt}`}
                    className="mock-list-row"
                  >
                    <span className="mock-row-top">
                      <span className="mock-row-title">{edit.filePath}</span>
                    </span>
                    <span className="mock-row-meta">
                      {edit.editorName ??
                        edit.editorLogin ??
                        'Unknown editor'}{' '}
                      · {formatTimestamp(edit.editedAt)}
                    </span>
                    {edit.pullRequestUrl !== null && (
                      <span className="mock-row-sub mock-row-wrap">
                        <a
                          href={edit.pullRequestUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {edit.pullRequestTitle ?? 'View pull request'} ↗
                        </a>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Module>
        )}
      </div>
    </aside>
  );
}
