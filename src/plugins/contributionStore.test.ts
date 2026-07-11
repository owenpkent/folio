import { beforeEach, describe, expect, it } from 'vitest';

import { useContributionStore } from './contributionStore';

describe('contributionStore', () => {
  beforeEach(() =>
    useContributionStore.setState({ toolbarItems: [], sidebarPanels: [], annotationTools: [] }),
  );

  it('adds and removes toolbar items', () => {
    useContributionStore.getState().addToolbarItem({ id: 'a', title: 'A', commandId: 'c' });
    expect(useContributionStore.getState().toolbarItems).toHaveLength(1);
    useContributionStore.getState().removeToolbarItem('a');
    expect(useContributionStore.getState().toolbarItems).toHaveLength(0);
  });

  it('adds and removes sidebar panels and annotation tools', () => {
    useContributionStore.getState().addSidebarPanel({ id: 'p', title: 'P', render: () => {} });
    useContributionStore.getState().addAnnotationTool({ id: 't', title: 'T' });
    expect(useContributionStore.getState().sidebarPanels).toHaveLength(1);
    expect(useContributionStore.getState().annotationTools).toHaveLength(1);

    useContributionStore.getState().removeSidebarPanel('p');
    useContributionStore.getState().removeAnnotationTool('t');
    expect(useContributionStore.getState().sidebarPanels).toHaveLength(0);
    expect(useContributionStore.getState().annotationTools).toHaveLength(0);
  });
});
