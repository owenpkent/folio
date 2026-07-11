import { describe, expect, it, vi } from 'vitest';

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
    expect(commandRegistry.get('test.run')?.title).toBe('Test run');
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

  it('passes a context argument to run', async () => {
    const run = vi.fn();
    commandRegistry.register({ id: 'test.ctx', title: 'Ctx', run });
    await commandRegistry.execute('test.ctx', { args: 42 });
    expect(run).toHaveBeenCalledWith({ args: 42 });
    commandRegistry.unregister('test.ctx');
  });

  it('notifies subscribers on register and unregister', () => {
    const listener = vi.fn();
    const unsub = commandRegistry.subscribe(listener);

    const dispose = commandRegistry.register({ id: 'test.sub', title: 'Sub', run: () => {} });
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    commandRegistry.register({ id: 'test.sub2', title: 'Sub2', run: () => {} });
    expect(listener).toHaveBeenCalledTimes(2);
    commandRegistry.unregister('test.sub2');
  });

  it('all() lists registered commands', () => {
    const before = commandRegistry.all().length;
    commandRegistry.register({ id: 'test.a', title: 'A', run: () => {} });
    commandRegistry.register({ id: 'test.b', title: 'B', run: () => {} });
    expect(commandRegistry.all().length).toBe(before + 2);
    commandRegistry.unregister('test.a');
    commandRegistry.unregister('test.b');
  });
});
