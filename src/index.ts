export {
  scanRecords,
  parseServerTimestamp,
  parseExportLine,
  KNOWN_DECODER_GAPS,
} from './frames.js';
export type {
  DecoderGap,
  FrameRecord,
  FrameRejection,
  FrameVerification,
  KnownDecoderGap,
  ScanOptions,
  ScanResult,
  RoomRecord,
  Unverified,
} from './frames.js';

export { buildThreads, recomputedContractId } from './threads.js';
export type { ContractThread, ThreadIndex } from './threads.js';

export {
  bindContracts,
  routeFrames,
  readDealRooms,
  exportRecords,
  framesByRoom,
} from './deal-rooms.js';
export type {
  Bindings,
  ContractBinding,
  ContractMismatch,
  DealRoomReads,
  RoutedFrames,
  WrongRoomFrame,
} from './deal-rooms.js';

export { audit } from './audit.js';
export type {
  Finding,
  FindingCode,
  Severity,
  AuditOptions,
  AuditReport,
  ThreadOutcome,
} from './audit.js';

export { Follower } from './follow.js';
export type { DealPass, FollowOptions, FollowPass } from './follow.js';

export { renderFindings, publishFindings, createNonceSource } from './publish.js';
export type { PublishOptions, PublishOutcome } from './publish.js';

export { containsAdvice, adviceReason, ADVICE_PATTERNS } from './advice-guard.js';

export { describeFinding, describeFindings } from './describe.js';
export type { DescribeOptions, DescribeResult, DescribeSkipReason } from './describe.js';

export { AdapterUnavailableError } from './inference/types.js';
export type {
  InferenceAdapter,
  InferenceRequest,
  InferenceResult,
  StopReason,
  Usage,
  Turn,
  Role,
} from './inference/types.js';

export { StubAdapter } from './inference/stub.js';
export type { StubOptions } from './inference/stub.js';
export { OllamaAdapter } from './inference/ollama.js';
export type { OllamaOptions } from './inference/ollama.js';

export { withAccounting, MemoryLedger, FileLedger, summarise } from './inference/ledger.js';
export type { Ledger, LedgerEntry, LedgerSummary } from './inference/ledger.js';
