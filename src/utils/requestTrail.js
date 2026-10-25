const { sha256, stableStringify, verifySignature } = require("./crypto");

const ZERO_HASH = "0".repeat(64);
const CATEGORIES = ["Plumbing", "Electrical", "Water supply", "Lift or common area", "Security", "Parking", "Other"];
const URGENCIES = ["Normal", "Urgent"];

const KINDS = {
  REQUESTED: { actor: "landlord", from: [null], required: ["category", "description", "urgency", "society"], optional: [] },
  ACKNOWLEDGED: { actor: "society", from: ["REQUESTED", "REOPENED"], required: [], optional: ["note", "expectedBy"] },
  REJECTED: { actor: "society", from: ["REQUESTED", "ACKNOWLEDGED", "REOPENED"], required: ["reason"], optional: [] },
  COMPLETED: { actor: "society", from: ["REQUESTED", "ACKNOWLEDGED", "REOPENED"], required: [], optional: ["note"] },
  REOPENED: { actor: "landlord", from: ["COMPLETED"], required: ["reason"], optional: [] },
  CANCELLED: { actor: "landlord", from: ["REQUESTED", "ACKNOWLEDGED", "REOPENED"], required: [], optional: ["reason"] },
  CLOSED: { actor: "landlord", from: ["COMPLETED"], required: ["ledgerEventId"], optional: ["note"] },
};

const STATUS_LABEL = {
  REQUESTED: "Requested",
  ACKNOWLEDGED: "Acknowledged",
  REOPENED: "Reopened",
  COMPLETED: "Completed",
  CLOSED: "Closed",
  REJECTED: "Declined",
  CANCELLED: "Cancelled",
};

function validateData(kind, data) {
  const spec = KINDS[kind];
  if (!spec) return "unknown step kind";
  if (!data || typeof data !== "object" || Array.isArray(data)) return "data (object) is required";
  const allowed = [...spec.required, ...spec.optional];
  if (!Object.keys(data).every((k) => allowed.includes(k))) return `data may only contain ${allowed.join(", ") || "nothing"}`;
  for (const key of spec.required) {
    if (data[key] === undefined || data[key] === null || data[key] === "") return `${key} is required`;
  }
  for (const key of Object.keys(data)) {
    if (typeof data[key] !== "string") return `${key} must be text`;
  }
  const max = { description: 500, note: 300, reason: 300, category: 40, urgency: 10, society: 60, expectedBy: 10, ledgerEventId: 12 };
  for (const key of Object.keys(data)) {
    if (data[key].trim() !== data[key] || data[key].length > max[key]) return `${key} is not valid`;
  }
  if (data.description !== undefined && data.description.length < 3) return "description is too short";
  if (data.category !== undefined && !CATEGORIES.includes(data.category)) return "category is not valid";
  if (data.urgency !== undefined && !URGENCIES.includes(data.urgency)) return "urgency is not valid";
  if (data.expectedBy !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(data.expectedBy)) return "expectedBy must be a date";
  if (data.ledgerEventId !== undefined && !/^evt-[0-9a-f]{8}$/.test(data.ledgerEventId)) return "ledgerEventId is not valid";
  return null;
}

function stepMessage({ requestId, leaseId, kind, by, at, data, prevHash }) {
  return stableStringify({ v: 1, requestId, leaseId, kind, by, at, data, prevHash });
}

function stepHash({ requestId, index, kind, by, at, data, prevHash, signature }) {
  return sha256({ requestId, index, kind, by, at, data, prevHash, signature });
}

function lastStep(request) {
  return request.steps[request.steps.length - 1];
}

function statusOf(request) {
  return STATUS_LABEL[lastStep(request).kind];
}

function societyOf(request) {
  return request.steps[0] && request.steps[0].data ? request.steps[0].data.society : null;
}

function verifyTrail(request, publicKeys) {
  let prevHash = ZERO_HASH;
  let prevKind = null;
  for (const step of request.steps) {
    const fail = (reason) => ({ valid: false, brokenAtIndex: step.index, reason: `Step ${step.index}: ${reason}` });
    const spec = KINDS[step.kind];
    if (!spec) return fail("unknown step.");
    if (step.index !== request.steps.indexOf(step)) return fail("out of order.");
    if (step.prevHash !== prevHash) return fail("does not link to the step before it.");
    if (stepHash({ requestId: request.id, ...step }) !== step.stepHash) return fail("the stored hash is inconsistent with its contents.");
    if (!spec.from.includes(prevKind)) return fail("this step is not allowed after the previous one.");
    const expectedActor = spec.actor === "landlord" ? request.landlordUsername : societyOf(request);
    if (step.by !== expectedActor) return fail("signed by someone who may not take this step.");
    const message = stepMessage({ requestId: request.id, leaseId: request.leaseId, kind: step.kind, by: step.by, at: step.at, data: step.data, prevHash: step.prevHash });
    if (!verifySignature(publicKeys[step.by], message, step.signature)) return fail(`the signature of ${step.by} does not verify.`);
    prevHash = step.stepHash;
    prevKind = step.kind;
  }
  return { valid: true, brokenAtIndex: null, reason: null };
}

module.exports = { ZERO_HASH, CATEGORIES, URGENCIES, KINDS, validateData, stepMessage, stepHash, lastStep, statusOf, societyOf, verifyTrail };
