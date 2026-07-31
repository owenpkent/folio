import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// eslint-plugin-react-hooks 7 folded the React Compiler rules into its
// `recommended` preset, so a project that spread that preset picked up 12 new
// error-level rules from a dependency bump alone. We name the two rules we
// opted into instead, and this asks eslint what it would actually apply to a
// real component file. If the set changes it should change here too, in a diff
// someone reviewed, rather than because an upstream preset grew.
const EXPECTED = {
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
};

const SEVERITY = ['off', 'warn', 'error'];

describe('eslint config', () => {
  it('enables exactly the react-hooks rules the project opted into', async () => {
    const config = await new ESLint().calculateConfigForFile(
      'src/features/signatures/SignatureModal.tsx',
    );

    const active: Record<string, string> = {};
    for (const [name, setting] of Object.entries(config.rules ?? {})) {
      if (!name.startsWith('react-hooks/')) continue;
      const severity = Array.isArray(setting) ? setting[0] : setting;
      const label = typeof severity === 'number' ? SEVERITY[severity] : String(severity);
      if (label !== 'off') active[name] = label;
    }

    expect(active).toEqual(EXPECTED);
  });
});
