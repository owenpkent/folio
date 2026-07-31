import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNearViewport } from './useNearViewport';

/**
 * A controllable IntersectionObserver. jsdom has none, and these tests are
 * specifically about how many get constructed and what happens to them, so a
 * recording fake is the point rather than a workaround.
 */
class FakeObserver {
  static instances: FakeObserver[] = [];

  targets = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit | undefined,
  ) {
    FakeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }

  /** Deliver a batch, the way a real observer does. Wrapped in act() because a
   *  real one also lands outside React's own event handling. */
  fire(entries: { target: Element; isIntersecting: boolean }[]): void {
    act(() => {
      this.callback(entries as unknown as IntersectionObserverEntry[], this as never);
    });
  }
}

function Probe({
  id,
  margin,
  rootSelector,
}: {
  id: string;
  margin: string;
  rootSelector?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref, margin, rootSelector);
  return (
    <div ref={ref} data-testid={id}>
      {near ? 'near' : 'far'}
    </div>
  );
}

describe('useNearViewport', () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports far until the observer says otherwise', () => {
    render(<Probe id="a" margin="100px 0px" />);
    expect(screen.getByTestId('a')).toHaveTextContent('far');
  });

  it('reports what the observer delivers, in both directions', () => {
    render(<Probe id="a" margin="100px 0px" />);
    const observer = FakeObserver.instances[0];
    const target = screen.getByTestId('a');

    observer.fire([{ target, isIntersecting: true }]);
    expect(screen.getByTestId('a')).toHaveTextContent('near');

    observer.fire([{ target, isIntersecting: false }]);
    expect(screen.getByTestId('a')).toHaveTextContent('far');
  });

  it('shares one observer across every element asking the same question', () => {
    render(
      <>
        <Probe id="a" margin="100px 0px" />
        <Probe id="b" margin="100px 0px" />
        <Probe id="c" margin="100px 0px" />
      </>,
    );

    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0].targets.size).toBe(3);
  });

  it('routes each entry to only its own element', () => {
    render(
      <>
        <Probe id="a" margin="100px 0px" />
        <Probe id="b" margin="100px 0px" />
      </>,
    );

    FakeObserver.instances[0].fire([{ target: screen.getByTestId('a'), isIntersecting: true }]);

    expect(screen.getByTestId('a')).toHaveTextContent('near');
    expect(screen.getByTestId('b')).toHaveTextContent('far');
  });

  it('uses a separate observer per root margin', () => {
    render(
      <>
        <Probe id="a" margin="100px 0px" />
        <Probe id="b" margin="2400px 0px" />
      </>,
    );

    expect(FakeObserver.instances).toHaveLength(2);
    expect(FakeObserver.instances.map((o) => o.options?.rootMargin)).toEqual([
      '100px 0px',
      '2400px 0px',
    ]);
  });

  it('unobserves one element without disturbing the others', () => {
    const { rerender } = render(
      <>
        <Probe id="a" margin="100px 0px" />
        <Probe id="b" margin="100px 0px" />
      </>,
    );
    const observer = FakeObserver.instances[0];
    expect(observer.targets.size).toBe(2);

    rerender(
      <>
        <Probe id="a" margin="100px 0px" />
      </>,
    );

    expect(observer.targets.size).toBe(1);
    expect(observer.disconnected).toBe(false);
  });

  it('disconnects once the last element goes away', () => {
    const { unmount } = render(<Probe id="a" margin="100px 0px" />);
    const observer = FakeObserver.instances[0];

    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it('builds a fresh observer after the previous one was disconnected', () => {
    const first = render(<Probe id="a" margin="100px 0px" />);
    first.unmount();

    render(<Probe id="b" margin="100px 0px" />);
    expect(FakeObserver.instances).toHaveLength(2);
    expect(FakeObserver.instances[1].disconnected).toBe(false);
  });

  it('resolves rootSelector to the scrolling ancestor', () => {
    render(
      <div className="scroller">
        <div className="inner">
          <Probe id="a" margin="300px 0px" rootSelector=".scroller" />
        </div>
      </div>,
    );

    expect(FakeObserver.instances[0].options?.root).toHaveClass('scroller');
  });

  it('falls back to the viewport when the selector matches nothing', () => {
    render(<Probe id="a" margin="300px 0px" rootSelector=".nope" />);
    expect(FakeObserver.instances[0].options?.root).toBeNull();
  });
});
