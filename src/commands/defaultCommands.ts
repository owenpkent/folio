import { invoke } from '@tauri-apps/api/core';

import { announce } from '@/a11y/announcer';
import { pushToast } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';
import { checkForUpdates } from '@/features/updates';
import { closeDocument, openDocumentViaPicker } from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';
import { scrollViewerByPage } from '@/state/viewerElement';
import { useViewerStore } from '@/state/viewerStore';
import { isNarrowViewport } from '@/theme/breakpoints';
import { useThemeStore } from '@/theme/themeStore';

import { commandRegistry } from './registry';
import type { Command } from './types';

const hasDocument = () => useDocumentStore.getState().status === 'ready';

function announceZoom(): void {
  announce(`Zoom ${Math.round(useViewerStore.getState().scale * 100)} percent`);
}
function announcePage(): void {
  const v = useViewerStore.getState();
  announce(`Page ${v.currentPage} of ${v.numPages}`);
}

const commands: Command[] = [
  // File
  {
    id: 'file.open',
    title: 'Open document…',
    category: 'File',
    keybinding: 'Mod+O',
    run: () => openDocumentViaPicker(),
  },
  {
    id: 'file.close',
    title: 'Close document',
    category: 'File',
    when: hasDocument,
    run: () => closeDocument(),
  },
  {
    id: 'file.setDefaultViewer',
    title: 'Set Folio as default PDF viewer',
    category: 'File',
    // Desktop only: opens the OS "Default apps" settings. Modern Windows will
    // not let an app seize a default handler silently, so we guide the user.
    when: () => isTauri(),
    run: async () => {
      try {
        await invoke('open_default_apps_settings');
        pushToast('Choose Folio for ".pdf" in the Settings window that opened.', 'info');
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        pushToast(messageText, 'error');
      }
    },
  },

  // View / zoom
  {
    id: 'view.zoomIn',
    title: 'Zoom in',
    category: 'View',
    keybinding: 'Mod+=',
    when: hasDocument,
    run: () => {
      useViewerStore.getState().zoomIn();
      announceZoom();
    },
  },
  {
    id: 'view.zoomOut',
    title: 'Zoom out',
    category: 'View',
    keybinding: 'Mod+-',
    when: hasDocument,
    run: () => {
      useViewerStore.getState().zoomOut();
      announceZoom();
    },
  },
  {
    id: 'view.zoomReset',
    title: 'Actual size (100%)',
    category: 'View',
    keybinding: 'Mod+0',
    when: hasDocument,
    run: () => {
      useViewerStore.getState().resetZoom();
      announceZoom();
    },
  },
  {
    id: 'view.fitWidth',
    title: 'Fit width',
    category: 'View',
    when: hasDocument,
    run: () => useViewerStore.getState().setFitMode('width'),
  },
  {
    id: 'view.fitPage',
    title: 'Fit page',
    category: 'View',
    when: hasDocument,
    run: () => useViewerStore.getState().setFitMode('page'),
  },
  {
    id: 'view.toggleSidebar',
    title: 'Toggle sidebar',
    category: 'View',
    keybinding: 'Mod+B',
    run: () => useViewerStore.getState().toggleSidebar(),
  },
  {
    id: 'view.closeSidebarDrawer',
    title: 'Close sidebar',
    category: 'View',
    keybinding: 'Escape',
    // Narrow viewports only, where the sidebar overlays the page as a drawer.
    // Listed before search.close so Escape peels the topmost layer first: the
    // drawer (z-index 60) sits above the search bar.
    when: () => isNarrowViewport() && useViewerStore.getState().sidebarOpen,
    run: () => useViewerStore.getState().setSidebarOpen(false),
  },
  {
    id: 'view.toggleHandMode',
    title: 'Hand tool (pan to scroll)',
    category: 'View',
    when: hasDocument,
    run: () => {
      useViewerStore.getState().toggleHandMode();
      announce(useViewerStore.getState().handMode ? 'Hand tool on' : 'Hand tool off');
    },
  },
  {
    id: 'view.toggleAutoScroll',
    title: 'Auto-scroll (continuous)',
    category: 'View',
    when: hasDocument,
    run: () => {
      useViewerStore.getState().toggleAutoScroll();
      announce(useViewerStore.getState().autoScroll ? 'Auto-scroll on' : 'Auto-scroll off');
    },
  },

  // Navigation
  {
    id: 'nav.nextPage',
    title: 'Next page',
    category: 'Navigate',
    keybinding: 'ArrowRight',
    when: hasDocument,
    run: () => {
      const v = useViewerStore.getState();
      v.goToPage(v.currentPage + 1);
      announcePage();
    },
  },
  {
    id: 'nav.prevPage',
    title: 'Previous page',
    category: 'Navigate',
    keybinding: 'ArrowLeft',
    when: hasDocument,
    run: () => {
      const v = useViewerStore.getState();
      v.goToPage(v.currentPage - 1);
      announcePage();
    },
  },
  // Scrolling is bound as commands rather than left to the browser: the keys
  // only scroll natively while the viewer holds focus, and any trip to the
  // toolbar or the find box takes that away.
  {
    id: 'nav.scrollDown',
    title: 'Scroll down one screen',
    category: 'Navigate',
    keybinding: 'PageDown',
    when: hasDocument,
    run: () => scrollViewerByPage(1),
  },
  {
    id: 'nav.scrollUp',
    title: 'Scroll up one screen',
    category: 'Navigate',
    keybinding: 'PageUp',
    when: hasDocument,
    run: () => scrollViewerByPage(-1),
  },
  {
    id: 'nav.firstPage',
    title: 'First page',
    category: 'Navigate',
    keybinding: 'Mod+Home',
    when: hasDocument,
    run: () => {
      useViewerStore.getState().goToPage(1);
      announcePage();
    },
  },
  {
    id: 'nav.lastPage',
    title: 'Last page',
    category: 'Navigate',
    keybinding: 'Mod+End',
    when: hasDocument,
    run: () => {
      const v = useViewerStore.getState();
      v.goToPage(v.numPages);
      announcePage();
    },
  },

  // Search
  {
    id: 'search.toggle',
    title: 'Find in document',
    category: 'Search',
    keybinding: 'Mod+F',
    when: hasDocument,
    run: () => useViewerStore.getState().toggleSearch(),
  },
  {
    id: 'search.close',
    title: 'Close find',
    category: 'Search',
    keybinding: 'Escape',
    when: () => useViewerStore.getState().searchOpen,
    run: () => useViewerStore.getState().setSearchOpen(false),
  },

  // Appearance
  {
    id: 'theme.toggle',
    title: 'Toggle light / dark',
    category: 'Appearance',
    keybinding: 'Mod+Shift+L',
    run: () => {
      useThemeStore.getState().toggleTheme();
      announce(`${useThemeStore.getState().resolvedTheme} theme`);
    },
  },

  // Help
  {
    id: 'help.about',
    title: 'About Folio',
    category: 'Help',
    run: () => useViewerStore.getState().setAboutModalOpen(true),
  },
  {
    id: 'help.checkForUpdates',
    title: 'Check for updates',
    category: 'Help',
    // Desktop only: the browser build has no Tauri shell to update.
    when: () => isTauri(),
    run: () => {
      void checkForUpdates(false);
    },
  },
];

let registered = false;

/** Register the built-in command set. Idempotent. */
export function registerDefaultCommands(): void {
  if (registered) return;
  registered = true;
  for (const command of commands) commandRegistry.register(command);
}
