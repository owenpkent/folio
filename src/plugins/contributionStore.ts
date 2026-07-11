import { create } from 'zustand';

import type { AnnotationToolDef, SidebarPanel, ToolbarItem } from './types';

/**
 * Reactive registry of UI contributions from plugins. The toolbar and sidebar
 * subscribe to this, so a plugin's items appear (and disappear) live as it is
 * activated or deactivated.
 */
interface ContributionState {
  toolbarItems: ToolbarItem[];
  sidebarPanels: SidebarPanel[];
  annotationTools: AnnotationToolDef[];

  addToolbarItem(item: ToolbarItem): void;
  removeToolbarItem(id: string): void;
  addSidebarPanel(panel: SidebarPanel): void;
  removeSidebarPanel(id: string): void;
  addAnnotationTool(tool: AnnotationToolDef): void;
  removeAnnotationTool(id: string): void;
}

export const useContributionStore = create<ContributionState>((set) => ({
  toolbarItems: [],
  sidebarPanels: [],
  annotationTools: [],

  addToolbarItem: (item) => set((s) => ({ toolbarItems: [...s.toolbarItems, item] })),
  removeToolbarItem: (id) =>
    set((s) => ({ toolbarItems: s.toolbarItems.filter((i) => i.id !== id) })),
  addSidebarPanel: (panel) => set((s) => ({ sidebarPanels: [...s.sidebarPanels, panel] })),
  removeSidebarPanel: (id) =>
    set((s) => ({ sidebarPanels: s.sidebarPanels.filter((p) => p.id !== id) })),
  addAnnotationTool: (tool) => set((s) => ({ annotationTools: [...s.annotationTools, tool] })),
  removeAnnotationTool: (id) =>
    set((s) => ({ annotationTools: s.annotationTools.filter((t) => t.id !== id) })),
}));
