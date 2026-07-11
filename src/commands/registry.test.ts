import { describe, expect, it } from 'vitest';

import { commandRegistry } from './registry';

describe('commandRegistry', () => {
  it('registers, executes, and disposes a command', async () => {
    let runs = 0;
    const dispose = commandRegistry.register({
      id: 'test.run',
      title: 'Test run',
      run: () => {
        runs += 1;
      },
    });

    expect(commandRegistry.has('test.run')).toBe(true);
    await commandRegistry.execute('test.run');
    expect(runs).toBe(1);

    dispose();
    expect(commandRegistry.has('test.run')).toBe(false);
  });

  it('does not run a command whose when() is false', async () => {
    let runs = 0;
    commandRegistry.register({
      id: 'test.guarded',
      title: 'Guarded',
      when: () => false,
      run: () => {
        runs += 1;
      },
    });

    await commandRegistry.execute('test.guarded');
    expect(runs).toBe(0);
    commandRegistry.unregister('test.guarded');
  });

  it('ignores execution of an unknown command', async () => {
    await expect(commandRegistry.execute('does.not.exist')).resolves.toBeUndefined();
  });
});
