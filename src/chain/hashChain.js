const { sha256, stableStringify, verifySignature } = require("../utils/crypto");

const GENESIS_HASH = "0".repeat(64);

function eventPayload(leaseId, event) {
  return {
    v: 1,
    leaseId,
    eventId: event.id,
    type: event.type,
    data: event.data,
    proposedBy: event.proposedBy,
    createdAt: event.createdAt,
  };
}

function confirmerMessage(leaseId, event, prevHash) {
  return stableStringify({ payload: eventPayload(leaseId, event), prevHash });
}

function computeBlockHash(block) {
  return sha256({
    index: block.index,
    finalizedAt: block.finalizedAt,
    photoId: block.photoId,
    confirmedBy: block.confirmedBy,
    proposerSignature: block.proposerSignature,
    confirmerSignature: block.confirmerSignature,
    prevHash: block.prevHash,
    dataHash: block.dataHash,
  });
}

class RentalEvidenceChain {
  constructor(leaseId) {
    this.leaseId = leaseId;
    this.blocks = [];
  }

  headHash() {
    const last = this.blocks[this.blocks.length - 1];
    return last ? last.blockHash : GENESIS_HASH;
  }

  addSignedEvent({ event, confirmedBy, confirmerSignature }) {
    const previousBlock = this.blocks[this.blocks.length - 1];
    const block = {
      index: this.blocks.length,
      finalizedAt: new Date().toISOString(),
      eventId: event.id,
      type: event.type,
      data: event.data,
      photoId: event.photoId || null,
      proposedBy: event.proposedBy,
      confirmedBy,
      createdAt: event.createdAt,
      proposerSignature: event.proposerSignature,
      confirmerSignature,
      prevHash: previousBlock ? previousBlock.blockHash : GENESIS_HASH,
      dataHash: sha256(eventPayload(this.leaseId, event)),
    };
    block.blockHash = computeBlockHash(block);
    this.blocks.push(block);
    return block;
  }

  verifyChain({ parties, publicKeys }) {
    let expectedPrevHash = GENESIS_HASH;

    for (const block of this.blocks) {
      const fail = (reason) => ({ valid: false, brokenAtIndex: block.index, reason: `Block ${block.index}: ${reason}` });

      if (block.prevHash !== expectedPrevHash) {
        return fail("does not link to the previous block.");
      }

      const payload = eventPayload(this.leaseId, {
        id: block.eventId,
        type: block.type,
        data: block.data,
        proposedBy: block.proposedBy,
        createdAt: block.createdAt,
      });

      if (sha256(payload) !== block.dataHash) {
        return fail("the recorded event data does not match its hash.");
      }
      if (computeBlockHash(block) !== block.blockHash) {
        return fail("the stored block hash is inconsistent with its contents.");
      }

      const signers = [block.proposedBy, block.confirmedBy];
      if (signers[0] === signers[1] || !signers.every((s) => parties.includes(s))) {
        return fail("signers are not the two parties of this lease.");
      }

      const message = stableStringify(payload);
      if (!verifySignature(publicKeys[block.proposedBy], message, block.proposerSignature)) {
        return fail(`the signature of ${block.proposedBy} does not verify.`);
      }
      const confirmMessage = stableStringify({ payload, prevHash: block.prevHash });
      if (!verifySignature(publicKeys[block.confirmedBy], confirmMessage, block.confirmerSignature)) {
        return fail(`the signature of ${block.confirmedBy} does not verify.`);
      }

      expectedPrevHash = block.blockHash;
    }

    return { valid: true, brokenAtIndex: null, reason: null };
  }

  tamperForDemo(index, newData, rehash) {
    this.blocks[index].data = newData;
    if (!rehash) return;
    let prev = index === 0 ? GENESIS_HASH : this.blocks[index - 1].blockHash;
    for (let i = index; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      block.prevHash = prev;
      if (i === index) {
        block.dataHash = sha256(
          eventPayload(this.leaseId, {
            id: block.eventId,
            type: block.type,
            data: block.data,
            proposedBy: block.proposedBy,
            createdAt: block.createdAt,
          })
        );
      }
      block.blockHash = computeBlockHash(block);
      prev = block.blockHash;
    }
  }

  toJSON() {
    return { leaseId: this.leaseId, blocks: this.blocks };
  }

  static fromJSON(json) {
    const chain = new RentalEvidenceChain(json.leaseId);
    chain.blocks = json.blocks;
    return chain;
  }
}

module.exports = { RentalEvidenceChain, GENESIS_HASH, eventPayload, confirmerMessage };
