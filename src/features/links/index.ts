export { AddressHint } from './AddressHint';
export { useAddressHover, type HintBox } from './hoverStore';
export { useTrackAddressHover } from './useTrackAddressHover';
export { copyTargetAt, type AddressHit, type AddressRegion } from './copyTarget';
export { addressAt, findAddresses, type AddressKind, type DetectedAddress } from './detect';
export {
  pickLink,
  pickTextItem,
  targetFromLink,
  targetFromOcr,
  targetFromText,
  type CopyTarget,
  type OcrWordLike,
  type ResolvedTarget,
  type TextItemLike,
} from './resolve';
