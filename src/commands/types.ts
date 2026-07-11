/** Optional payload passed to a command's `run`. */
export interface CommandContext {
  args?: unknown;
}

/**
 * A single user-invokable action. Commands are the one way the app performs
 * anything the user can trigger: toolbar clicks, keyboard shortcuts, the
 * (future) command palette, plugins, and AI actions all dispatch commands.
 */
export interface Command {
  /** Stable, namespaced id, e.g. "view.zoomIn". */
  id: string;
  /** Human-readable label shown in menus / the command palette. */
  title: string;
  /** Grouping label, e.g. "View". */
  category?: string;
  /** Declarative shortcut, e.g. "Mod+O" (Mod = Cmd on macOS, Ctrl elsewhere). */
  keybinding?: string;
  /** Guard: the command is only enabled/dispatchable when this returns true. */
  when?: () => boolean;
  run(ctx?: CommandContext): void | Promise<void>;
}

export type Unsubscribe = () => void;

export interface CommandRegistry {
  register(command: Command): Unsubscribe;
  unregister(id: string): void;
  get(id: string): Command | undefined;
  has(id: string): boolean;
  all(): Command[];
  execute(id: string, ctx?: CommandContext): Promise<void>;
  subscribe(listener: () => void): Unsubscribe;
}
