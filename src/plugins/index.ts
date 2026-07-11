import { builtinPlugins } from './builtins';
import { pluginHost } from './PluginHost';

export { pluginHost } from './PluginHost';
export { useContributionStore } from './contributionStore';
export * from './types';

/** Activate every built-in plugin. Called once on startup. */
export async function activateBuiltinPlugins(): Promise<void> {
  for (const plugin of builtinPlugins) {
    await pluginHost.activate(plugin);
  }
}
