import { describe, expect, it } from 'vitest';

import { formWidgetAt } from './formsLayer';

/** Stub document.elementsFromPoint (jsdom does not implement it) for one call. */
function stubElementsFromPoint(elements: Element[]): void {
  document.elementsFromPoint = (() => elements) as unknown as typeof document.elementsFromPoint;
}

describe('formWidgetAt', () => {
  it('finds an input inside the forms layer', () => {
    const layer = document.createElement('div');
    layer.className = 'folio-forms-layer';
    const input = document.createElement('input');
    layer.appendChild(input);
    stubElementsFromPoint([input, layer]);

    expect(formWidgetAt(10, 10)).toBe(input);
  });

  it('finds a select or textarea inside the forms layer', () => {
    const layer = document.createElement('div');
    layer.className = 'folio-forms-layer';
    const select = document.createElement('select');
    const textarea = document.createElement('textarea');
    layer.append(select, textarea);

    stubElementsFromPoint([select, layer]);
    expect(formWidgetAt(10, 10)).toBe(select);

    stubElementsFromPoint([textarea, layer]);
    expect(formWidgetAt(10, 10)).toBe(textarea);
  });

  it('ignores a widget-shaped element that is not inside the forms layer', () => {
    const input = document.createElement('input');
    stubElementsFromPoint([input]);

    expect(formWidgetAt(10, 10)).toBeNull();
  });

  it('sees past the click-catcher on top to the widget underneath it', () => {
    const layer = document.createElement('div');
    layer.className = 'folio-forms-layer';
    const input = document.createElement('input');
    layer.appendChild(input);
    const catcher = document.createElement('button');

    // elementsFromPoint orders front (topmost) to back; the catcher paints
    // above the forms layer (see global.css's z-index comments), so it is
    // reported first, ahead of the widget it sits on top of.
    stubElementsFromPoint([catcher, input, layer]);

    expect(formWidgetAt(10, 10)).toBe(input);
  });

  it('returns null when there is nothing at the point', () => {
    stubElementsFromPoint([]);
    expect(formWidgetAt(0, 0)).toBeNull();
  });
});
