export { scanRecords, parseServerTimestamp } from './frames.js';
export type { FrameRecord, FrameRejection, ScanResult, RoomRecord } from './frames.js';

export { buildThreads } from './threads.js';
export type { ContractThread, ThreadIndex } from './threads.js';

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
export type { FollowOptions, FollowPass } from './follow.js';

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
