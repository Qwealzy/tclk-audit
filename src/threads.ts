import {
  contractId,
  type AcceptCore,
  type AcceptFrame,
  type OfferFrame,
} from '@flop-labs/tclk';
import type { FrameRecord } from './frames.js';

/**
 * Grouping frames into per-contract threads.
 *
 * This is the one place the auditor has to do real work that the library does
 * not, and it is fiddly because a contract is named by two different ids over
 * its life:
 *
 *   - an `offer` carries `id`;
 *   - an `accept` carries `ref` (the offer id) AND `contract` (the contract id,
 *     which SPEC §3.2 derives from the full offer plus the acceptance);
 *   - every later frame names only `contract`.
 *
 * So the accept is the hinge: without it, later frames cannot be attributed to
 * the offer they belong to. A thread is keyed on the offer id because that is
 * the identifier present from the beginning.
 *
 * The accept's `contract` field is written by its sender. So a contract id is
 * taken only from an accept it can be recomputed for. See
 * `recomputedContractId`.
 */

/**
 * The contract id SPEC §3.2 gives for this offer and acceptance, computed with
 * 0.1.0's own `contractId`.
 *
 * STATED [SPEC.md section 3.2, 0.1.0]: `contract` = `0x` + sha256 of
 * `FLOP::tclk::v1|contract|<canonical {offer, accept-core}>`, binding the full
 * offer and the acceptance (`ref`, `from`, `statement`, `paymentKey`,
 * `nonce`). "Both sides recompute it; a mismatch rejects the frame."
 */
export function recomputedContractId(offer: OfferFrame, accept: AcceptFrame): string {
  const core: AcceptCore = {
    from: accept.from,
    ref: accept.ref,
    statement: accept.statement,
    nonce: accept.nonce,
  };
  if (accept.paymentKey !== undefined) core.paymentKey = accept.paymentKey;
  return contractId(offer, core);
}

export interface ContractThread {
  /** The offer id, or a synthetic key when the offer was never seen. */
  readonly key: string;
  /** Present when the offer itself is in the scanned window. */
  readonly offer: FrameRecord | null;
  /**
   * The contract id of the first accept here whose id recomputes from this
   * offer. Null when no accept here does, including when the offer is absent.
   */
  readonly contractId: string | null;
  /** Every frame attributed to this thread, in room order. */
  readonly frames: readonly FrameRecord[];
  /** Lowest seq in the thread, for the warm-up boundary in audit.ts. */
  readonly firstSeq: bigint;
}

export interface ThreadIndex {
  readonly threads: readonly ContractThread[];
  /**
   * Frames naming a contract whose accept was never seen, so they cannot be
   * attributed to any offer. Kept separately rather than dropped: near the
   * start of a retained window these are almost always the ring having
   * forgotten the earlier frames, not a fault. A frame naming an id that no
   * accept here recomputes to lands here too.
   */
  readonly unattributed: readonly FrameRecord[];
}

function frameContractId(record: FrameRecord): string | null {
  const frame = record.frame as { contract?: unknown };
  return typeof frame.contract === 'string' ? frame.contract : null;
}

export function buildThreads(frames: readonly FrameRecord[]): ThreadIndex {
  // Room order is the only order trusted here. STATED [CONVENTIONS]: "seq is
  // the total order within a room. It is assigned under a lock and is
  // contiguous, so two readers always agree. ts is for humans: it is UTC to
  // the microsecond, but never the tiebreak."
  const ordered = [...frames].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  const offers = new Map<string, FrameRecord>();
  const contractToOffer = new Map<string, string>();
  /** Accepts whose own fields hash to their `contract` field. */
  const recomputes = new Set<FrameRecord>();

  for (const record of ordered) {
    if (record.frame.type === 'offer') {
      // First writer wins on a duplicate id: the offer id is a hash of the
      // offer's own fields, so a repeat is the same offer posted twice.
      if (!offers.has(record.frame.id)) offers.set(record.frame.id, record);
    }
  }

  for (const record of ordered) {
    if (record.frame.type !== 'accept') continue;
    // An accept whose offer is not here cannot be checked, and one whose
    // `contract` is not what the two hash to names no real contract. Neither
    // gives a contract id to attribute later frames by.
    const offer = offers.get(record.frame.ref);
    if (offer === undefined || offer.frame.type !== 'offer') continue;
    if (recomputedContractId(offer.frame, record.frame) !== record.frame.contract) continue;
    recomputes.add(record);
    // First accept binds the contract. A second accept on the same offer is
    // a real event the state machine will reject, and it must not be allowed
    // to re-point the mapping.
    if (!contractToOffer.has(record.frame.contract)) {
      contractToOffer.set(record.frame.contract, record.frame.ref);
    }
  }

  const grouped = new Map<string, FrameRecord[]>();
  const unattributed: FrameRecord[] = [];

  for (const record of ordered) {
    let key: string | null = null;

    if (record.frame.type === 'offer') {
      key = record.frame.id;
    } else if (record.frame.type === 'accept') {
      key = record.frame.ref;
    } else {
      const contract = frameContractId(record);
      key = contract === null ? null : (contractToOffer.get(contract) ?? null);
    }

    if (key === null) {
      unattributed.push(record);
      continue;
    }
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [record]);
    else list.push(record);
  }

  const threads: ContractThread[] = [];
  for (const [key, list] of grouped) {
    const offer = offers.get(key) ?? null;
    // An accept counts only if its own fields hash to its `contract`. Another
    // accept can carry a valid id it did not earn.
    const accept = list.find((r) => recomputes.has(r));
    threads.push({
      key,
      offer,
      contractId:
        accept !== undefined && accept.frame.type === 'accept' ? accept.frame.contract : null,
      frames: list,
      firstSeq: list.reduce((lowest, r) => (r.seq < lowest ? r.seq : lowest), list[0]!.seq),
    });
  }

  threads.sort((a, b) => (a.firstSeq < b.firstSeq ? -1 : a.firstSeq > b.firstSeq ? 1 : 0));
  return { threads, unattributed };
}
