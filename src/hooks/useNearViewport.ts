import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether an element is within `rootMargin` of the scroller, sharing one
 * `IntersectionObserver` across every caller that asks the same question.
 *
 * A `new IntersectionObserver` per page meant a 2000-page document allocated
 * 2000 observers to do what one observer with 2000 targets does, and the
 * browser delivers their callbacks separately rather than in a single batched
 * record list.
 *
 * `rootSelector` picks the scroller by walking up from the observed element,
 * because that element is the only handle a caller has at effect time. It must
 * name the element that actually scrolls: with an element root,
 * IntersectionObserver clips against containers *between* target and root and
 * never above the root, so naming an unclipped inner wrapper reports every
 * target as visible at once. Passing none uses the viewport.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  rootMargin: string,
  rootSelector?: string,
): boolean {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const root = rootSelector ? element.closest(rootSelector) : null;
    const group = observerFor(root, rootMargin);
    group.callbacks.set(element, setNear);
    group.observer.observe(element);

    return () => {
      group.observer.unobserve(element);
      group.callbacks.delete(element);
      // Last subscriber out shuts the observer down, so switching documents or
      // closing the sidebar does not leave one wired to a detached scroller.
      if (group.callbacks.size === 0) {
        group.observer.disconnect();
        groups.delete(group.key);
      }
    };
  }, [ref, rootMargin, rootSelector]);

  return near;
}

interface ObserverGroup {
  key: string;
  observer: IntersectionObserver;
  callbacks: Map<Element, (near: boolean) => void>;
}

const groups = new Map<string, ObserverGroup>();

function observerFor(root: Element | null, rootMargin: string): ObserverGroup {
  // Roots are distinguished by identity, not by selector: two sidebars with the
  // same selector are still two scrollers. A WeakMap keyed on the root would be
  // tidier, but the null (viewport) root has no key, so an id is stamped on.
  const key = `${rootId(root)}|${rootMargin}`;
  const existing = groups.get(key);
  if (existing) return existing;

  const group: ObserverGroup = {
    key,
    callbacks: new Map(),
    observer: new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          groups.get(key)?.callbacks.get(entry.target)?.(entry.isIntersecting);
        }
      },
      { root, rootMargin },
    ),
  };
  groups.set(key, group);
  return group;
}

const rootIds = new WeakMap<Element, string>();
let nextRootId = 0;

function rootId(root: Element | null): string {
  if (!root) return 'viewport';
  let id = rootIds.get(root);
  if (!id) {
    id = `root${(nextRootId += 1)}`;
    rootIds.set(root, id);
  }
  return id;
}
