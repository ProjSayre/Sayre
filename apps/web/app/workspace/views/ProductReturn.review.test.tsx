import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { fixtureWorkspaceDataSource, type WorkspaceDataSource } from '../dataSource';
import { FeatureDrawer } from '../drawer/FeatureDrawer';
import { NodeDrawer } from '../drawer/NodeDrawer';
import { WorkspaceProvider, useWorkspaceFixture } from '../state';

(globalThis as unknown as { React: typeof React }).React = React;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function sourceWithProduct(
  productTree: WorkspaceDataSource['productTree'],
): WorkspaceDataSource {
  return { ...fixtureWorkspaceDataSource, productTree };
}

describe('Product-to-Technical return-path review remediation', () => {
  // @spec AC-5 EC-12
  it('renders no Explore code action when the authorized feature has no mapped file', async () => {
    const source = sourceWithProduct(async (scope, signal) => {
      const product = await fixtureWorkspaceDataSource.productTree(scope, signal);
      return {
        ...product,
        features: product.features.map((feature, index) => index === 0
          ? { ...feature, memberIds: ['missing-authorized-file'] }
          : feature),
      };
    });
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider source={source} initialView="product" initialFeatureId="feat_checkout">
          <FeatureDrawer />
        </WorkspaceProvider>,
      );
    });
    await settle();
    expect(renderer!.root.findAll((node) => node.type === 'button' && /Explore code/i.test(String(node.props.children)))).toHaveLength(0);
    await act(async () => renderer!.unmount());
  });

  // @spec AC-5 EC-12
  it('keeps the originating feature through rapid rendered Explore code activation', async () => {
    let fixture: NonNullable<ReturnType<typeof useWorkspaceFixture>> | null = null;
    function Probe() {
      fixture = useWorkspaceFixture()!;
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider source={fixtureWorkspaceDataSource} initialView="product" initialFeatureId="feat_checkout">
          <FeatureDrawer />
          <Probe />
        </WorkspaceProvider>,
      );
    });
    await settle();
    const explore = renderer!.root.find((node) => node.type === 'button' && /Explore code/i.test(String(node.props.children)));
    await act(async () => {
      explore.props.onClick();
      explore.props.onClick();
    });
    expect(fixture!.state).toMatchObject({
      view: 'technical',
      selectedNodeId: 'n_checkout_page',
      selectedFeatureId: null,
      returnFeatureId: 'feat_checkout',
      drawerOpen: true,
      fileTreeOpen: true,
    });
    await act(async () => renderer!.unmount());
  });

  // @spec AC-5 EC-13
  it('revalidates the rendered return target in Product and clears a removed feature safely', async () => {
    let includeOrigin = true;
    const source = sourceWithProduct(async (scope, signal) => {
      const product = await fixtureWorkspaceDataSource.productTree(scope, signal);
      return includeOrigin
        ? product
        : { ...product, features: product.features.filter((feature) => feature.id !== 'feat_checkout') };
    });
    let fixture: NonNullable<ReturnType<typeof useWorkspaceFixture>> | null = null;
    function Probe() {
      fixture = useWorkspaceFixture()!;
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider source={source} initialView="product" initialFeatureId="feat_checkout">
          <FeatureDrawer />
          <NodeDrawer />
          <Probe />
        </WorkspaceProvider>,
      );
    });
    await settle();
    const explore = renderer!.root.find((node) => node.type === 'button' && /Explore code/i.test(String(node.props.children)));
    await act(async () => explore.props.onClick());
    await settle();
    includeOrigin = false;
    const back = renderer!.root.findByProps({ 'data-workspace-action': 'back-to-feature' });
    await act(async () => back.props.onClick());
    await settle();
    expect(fixture!.state).toMatchObject({
      view: 'product',
      selectedNodeId: null,
      selectedFeatureId: null,
      returnFeatureId: null,
      drawerOpen: false,
    });
    expect(renderer!.root.findAllByProps({ 'data-workspace-action': 'back-to-feature' })).toHaveLength(0);
    await act(async () => renderer!.unmount());
  });
});
