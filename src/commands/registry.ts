import type { Command, CommandContext, CommandRegistry, Unsubscribe } from './types';

class CommandRegistryImpl implements CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();

  register(command: Command): Unsubscribe {
    if (this.commands.has(command.id)) {
      console.warn(`[folio] command "${command.id}" already registered; overwriting.`);
    }
    this.commands.set(command.id, command);
    this.emit();
    return () => this.unregister(command.id);
  }

  unregister(id: string): void {
    if (this.commands.delete(id)) this.emit();
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  all(): Command[] {
    return [...this.commands.values()];
  }

  async execute(id: string, ctx?: CommandContext): Promise<void> {
    const command = this.commands.get(id);
    if (!command) {
      console.warn(`[folio] no command registered for "${id}"`);
      return;
    }
    if (command.when && !command.when()) return;
    try {
      await command.run(ctx);
    } catch (error) {
      // A command that throws (or a promise it returns that rejects) would
      // otherwise surface as an unhandled rejection with no message the user
      // ever sees, since most callers (keyboard shortcuts, menu items) fire
      // this and move on without awaiting it themselves.
      console.error(`[folio] command "${id}" failed:`, error);
    }
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** The single, app-wide command registry. */
export const commandRegistry: CommandRegistry = new CommandRegistryImpl();
