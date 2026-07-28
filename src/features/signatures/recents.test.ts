import { beforeEach, describe, expect, it } from 'vitest';

import { getRecentSignatureNames, rememberSignatureName } from './recents';
import { SIGNATURE_FONTS } from './types';

const SCRIPT = SIGNATURE_FONTS[0].value;
const SERIF = SIGNATURE_FONTS[1].value;
const KEY = 'folio.signatures.recentNames';

describe('recent signature names', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('remembers a name with its font, most recent first', () => {
    rememberSignatureName('Ada Lovelace', SCRIPT);
    rememberSignatureName('A. Lovelace', SERIF);

    expect(getRecentSignatureNames()).toEqual([
      { name: 'A. Lovelace', font: SERIF },
      { name: 'Ada Lovelace', font: SCRIPT },
    ]);
  });

  it('moves a re-used name to the front instead of duplicating it', () => {
    rememberSignatureName('Ada Lovelace', SCRIPT);
    rememberSignatureName('Grace Hopper', SCRIPT);
    rememberSignatureName('  ada lovelace  ', SERIF);

    expect(getRecentSignatureNames()).toEqual([
      { name: 'ada lovelace', font: SERIF },
      { name: 'Grace Hopper', font: SCRIPT },
    ]);
  });

  it('keeps at most five names', () => {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) rememberSignatureName(name, SCRIPT);

    const names = getRecentSignatureNames().map((r) => r.name);
    expect(names).toEqual(['f', 'e', 'd', 'c', 'b']);
  });

  it('ignores a blank name', () => {
    rememberSignatureName('   ', SCRIPT);
    expect(getRecentSignatureNames()).toEqual([]);
  });

  it('discards junk and unknown fonts from storage', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { name: 'Ada', font: 'expression(evil)' },
        { name: '', font: SCRIPT },
        'not an entry',
        { name: 'Grace', font: SERIF },
      ]),
    );

    expect(getRecentSignatureNames()).toEqual([
      { name: 'Ada', font: SCRIPT },
      { name: 'Grace', font: SERIF },
    ]);
  });

  it('survives unparseable storage', () => {
    localStorage.setItem(KEY, '{not json');
    expect(getRecentSignatureNames()).toEqual([]);
  });
});
