import { beforeEach, describe, expect, it } from 'vitest';

import { useAnnotationStore } from './store';

const rects = [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }];

describe('annotation store', () => {
  beforeEach(() => {
    localStorage.clear();
    useAnnotationStore.getState().reset();
  });

  it('adds a highlight and persists it under the fingerprint', () => {
    useAnnotationStore.getState().loadForDocument('fp1');
    const a = useAnnotationStore.getState().addHighlight(2, rects, 'hello', 'yellow');

    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
    expect(a.pageNumber).toBe(2);
    expect(a.type).toBe('highlight');
    expect(localStorage.getItem('folio.annotations.fp1')).toContain('hello');
  });

  it('reloads persisted annotations for a fingerprint', () => {
    useAnnotationStore.getState().loadForDocument('fp2');
    useAnnotationStore.getState().addHighlight(1, rects, 'x', 'y');

    useAnnotationStore.getState().reset();
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);

    useAnnotationStore.getState().loadForDocument('fp2');
    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
  });

  it('sets a note and removes an annotation', () => {
    useAnnotationStore.getState().loadForDocument('fp3');
    const a = useAnnotationStore.getState().addHighlight(1, rects, 'x', 'y');

    useAnnotationStore.getState().setNote(a.id, 'my note');
    expect(useAnnotationStore.getState().annotations[0].note).toBe('my note');

    useAnnotationStore.getState().remove(a.id);
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);
  });
});
