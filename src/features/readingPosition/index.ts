export { positionKeys, type PositionKeys } from './aliases';
export { findPosition, setReadingPosition, type ReadingPosition } from './store';
export { clearLastDocument, readLastDocument, type LastDocument } from './lastDocument';
export {
  flushReadingPosition,
  recordPositionForBytes,
  startReadingPosition,
  stopReadingPosition,
} from './recorder';
