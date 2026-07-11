import type { FolioPlugin } from '../types';
import { wordCountPlugin } from './wordCount';

/** Plugins that ship with Folio and are activated on startup. */
export const builtinPlugins: FolioPlugin[] = [wordCountPlugin];
