import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';

// Nothing rasterises here (no thumbnail reports as near the viewport), but the
// module still resolves the engine on import.
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return { ...actual, getEngine: () => ({ renderPage: async () => {} }) };
});

const deleteSelectedPages = vi.fn();
vi.mock('./operations', () => ({
  deleteSelectedPages: () => deleteSelectedPages(),
  moveSelectionTo: vi.fn(),
}));

import { resetPageSizes } from '@/core/pdf/pageSizes';
import { useViewerStore } from '@/state/viewerStore';

import { PageList } from './PageList';
import { usePageOpsStore } from './store';

const renderList = () =>
  render(
    <PageList
      layout="column"
      scrollRoot=".folio-sidebar__body"
      scale={0.2}
      rootMargin="300px 0px"
    />,
  );

const renderGrid = () =>
  render(
    <PageList
      layout="grid"
      scrollRoot=".folio-organize__body"
      scale={0.35}
      rootMargin="600px 0px"
    />,
  );

const selection = () => [...usePageOpsStore.getState().selection].sort((a, b) => a - b);
const checkbox = (page: number) => screen.getByRole('checkbox', { name: `Select page ${page}` });
const thumb = (page: number) => screen.getByRole('button', { name: `Go to page ${page}` });

describe('PageList', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    useViewerStore.setState({ numPages: 5 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    useViewerStore.getState().reset();
    usePageOpsStore.getState().reset();
    resetPageSizes();
  });

  it('renders a card and a checkbox per page', () => {
    renderList();
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    expect(document.querySelectorAll('.folio-page-card')).toHaveLength(5);
  });

  it('picks a page out without navigating to it', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(checkbox(2));

    expect(selection()).toEqual([2]);
    expect(useViewerStore.getState().currentPage).toBe(1);
  });

  it('reports selection to a screen reader through aria-checked', async () => {
    const user = userEvent.setup();
    renderList();

    expect(checkbox(3)).toHaveAttribute('aria-checked', 'false');
    await user.click(checkbox(3));
    expect(checkbox(3)).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles a page back off', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(checkbox(2));
    await user.click(checkbox(2));

    expect(selection()).toEqual([]);
  });

  it('extends a range on shift-click', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(checkbox(2));
    await user.keyboard('{Shift>}');
    await user.click(checkbox(4));
    await user.keyboard('{/Shift}');

    expect(selection()).toEqual([2, 3, 4]);
  });

  it('navigates on a plain click of the page itself', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(thumb(3));

    expect(useViewerStore.getState().currentPage).toBe(3);
    expect(selection()).toEqual([]);
  });

  it('selects rather than navigates on ctrl-click', async () => {
    const user = userEvent.setup();
    renderList();

    await user.keyboard('{Control>}');
    await user.click(thumb(3));
    await user.keyboard('{/Control}');

    expect(selection()).toEqual([3]);
    expect(useViewerStore.getState().currentPage).toBe(1);
  });

  it('picks a page out with Space rather than opening it', async () => {
    const user = userEvent.setup();
    renderList();

    thumb(2).focus();
    await user.keyboard(' ');

    expect(selection()).toEqual([2]);
    expect(useViewerStore.getState().currentPage).toBe(1);
  });

  it('does not delete on Delete in the reading sidebar', async () => {
    // Backspace and Delete are exactly the keys browser-back muscle memory
    // reaches for, and this button's accessible name is "Go to page N" --
    // indistinguishable from any other "go back" control. The sidebar is for
    // reading, not reorganising, so a destructive key here has to be inert.
    const user = userEvent.setup();
    renderList();

    await user.click(checkbox(2));
    thumb(2).focus();
    await user.keyboard('{Delete}');

    expect(deleteSelectedPages).not.toHaveBeenCalled();
    expect(selection()).toEqual([2]);
  });

  it('does not select an unpicked page on Delete in the reading sidebar either', async () => {
    const user = userEvent.setup();
    renderList();

    thumb(4).focus();
    await user.keyboard('{Delete}');

    expect(selection()).toEqual([]);
    expect(deleteSelectedPages).not.toHaveBeenCalled();
  });

  it('says so when there is no document', () => {
    useViewerStore.setState({ numPages: 0 });
    renderList();

    expect(screen.getByText('No document open.')).toBeInTheDocument();
  });
});

describe('PageList in the organizer grid', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    useViewerStore.setState({ numPages: 5 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    useViewerStore.getState().reset();
    usePageOpsStore.getState().reset();
    resetPageSizes();
  });

  it('deletes the selection on Delete', async () => {
    const user = userEvent.setup();
    renderGrid();

    await user.click(checkbox(2));
    thumb(2).focus();
    await user.keyboard('{Delete}');

    expect(deleteSelectedPages).toHaveBeenCalledTimes(1);
  });

  it('treats Delete on an unpicked page as meaning that page', async () => {
    const user = userEvent.setup();
    renderGrid();

    thumb(4).focus();
    await user.keyboard('{Delete}');

    expect(selection()).toEqual([4]);
    expect(deleteSelectedPages).toHaveBeenCalledTimes(1);
  });

  it('navigates and calls onNavigate on a plain click, closing the organizer', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <PageList
        layout="grid"
        scrollRoot=".folio-organize__body"
        scale={0.35}
        rootMargin="600px 0px"
        onNavigate={onNavigate}
      />,
    );

    await user.click(thumb(3));

    expect(useViewerStore.getState().currentPage).toBe(3);
    expect(onNavigate).toHaveBeenCalledWith(3);
  });
});
