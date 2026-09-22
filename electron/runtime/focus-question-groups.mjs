const MAX_MEMBERS = 50;
const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 50;
const MAX_TEXT = 4_000;
const MAX_ID = 512;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, { allowEmpty = true } = {}) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if ((!allowEmpty && !normalized) || normalized.length > MAX_TEXT) return null;
  return normalized;
}

function identity(key, generation) {
  if (typeof key !== "string" || !key.trim() || key.length > MAX_ID) return null;
  if (!(typeof generation === "string" || typeof generation === "number") || !Number.isFinite(Number(generation))) return null;
  return JSON.stringify([key, generation]);
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) return null;
  const ids = new Set();
  const shape = [];
  const questionIds = [];
  for (const question of questions) {
    if (!plainObject(question) || typeof question.id !== "string" || !question.id.trim() || question.id.length > MAX_ID) return null;
    if (Object.keys(question).some((key) => !["id", "header", "question", "options"].includes(key))) return null;
    if (ids.has(question.id)) return null;
    ids.add(question.id);
    const header = normalizeText(question.header);
    const text = normalizeText(question.question, { allowEmpty: false });
    if (header === null || text === null || !Array.isArray(question.options) || question.options.length > MAX_OPTIONS) return null;
    const options = [];
    for (const option of question.options) {
      if (!plainObject(option)) return null;
      if (Object.keys(option).some((key) => !["label", "description", "isOther", "recommended"].includes(key))) return null;
      const label = normalizeText(option.label, { allowEmpty: false });
      const description = normalizeText(option.description);
      if (label === null || description === null || option.isOther !== undefined && typeof option.isOther !== "boolean" || option.recommended !== undefined && typeof option.recommended !== "boolean") return null;
      options.push({ label, description, isOther: option.isOther === true, recommended: option.recommended === true });
    }
    questionIds.push(question.id);
    shape.push({ header, question: text, options });
  }
  return { fingerprint: JSON.stringify(shape), questionIds };
}

function detachedResult(key, generation) {
  return { leaderKey: key, leaderGeneration: generation, duplicate: false };
}

/**
 * Groups only structurally identical question batches. It never interprets or
 * invents answers; callers remain responsible for validating native replies.
 */
export class FocusQuestionGroups {
  constructor() {
    this.groupsByFingerprint = new Map();
    this.membersByIdentity = new Map();
    this.latestGenerationByKey = new Map();
  }

  add({ key, generation, projectId, questions } = {}) {
    const memberIdentity = identity(key, generation);
    const normalized = normalizeQuestions(questions);
    if (!memberIdentity || typeof projectId !== "string" || !projectId || !normalized) return detachedResult(key, generation);

    const existing = this.membersByIdentity.get(memberIdentity);
    if (existing) {
      if (existing.group.projectId !== projectId || existing.group.fingerprint !== normalized.fingerprint || !sameIds(existing.member.questionIds, normalized.questionIds)) {
        return detachedResult(key, generation);
      }
      return {
        leaderKey: existing.group.leader.key,
        leaderGeneration: existing.group.leader.generation,
        duplicate: existing.member !== existing.group.leader
      };
    }

    const latestGeneration = this.latestGenerationByKey.get(key);
    if (latestGeneration !== undefined && Number(generation) <= Number(latestGeneration)) return detachedResult(key, generation);
    if (latestGeneration !== undefined) {
      [...this.membersByIdentity.values()]
        .filter((indexed) => indexed.member.key === key)
        .forEach((indexed) => this.remove(indexed.member.key, indexed.member.generation));
    }
    this.latestGenerationByKey.set(key, generation);

    const bucketKey = JSON.stringify([projectId, normalized.fingerprint]);
    const bucket = this.groupsByFingerprint.get(bucketKey) ?? [];
    const group = bucket.find((candidate) => candidate.members.length < MAX_MEMBERS);
    const member = { key, generation, questionIds: normalized.questionIds };
    if (group) {
      group.members.push(member);
      this.membersByIdentity.set(memberIdentity, { group, member, bucketKey });
      return { leaderKey: group.leader.key, leaderGeneration: group.leader.generation, duplicate: true };
    }

    const created = { projectId, fingerprint: normalized.fingerprint, leader: member, members: [member] };
    bucket.push(created);
    this.groupsByFingerprint.set(bucketKey, bucket);
    this.membersByIdentity.set(memberIdentity, { group: created, member, bucketKey });
    return detachedResult(key, generation);
  }

  resolve(leaderKey, leaderGeneration, answers) {
    const leaderIdentity = identity(leaderKey, leaderGeneration);
    const indexed = leaderIdentity && this.membersByIdentity.get(leaderIdentity);
    if (!indexed || indexed.group.leader !== indexed.member || !plainObject(answers)) return [];
    const group = indexed.group;
    const resolved = group.members.map((member) => ({
      key: member.key,
      generation: member.generation,
      answers: remapAnswers(group.leader.questionIds, member.questionIds, answers)
    }));
    this.#deleteGroup(group, indexed.bucketKey);
    return resolved;
  }

  remove(key, generation) {
    const memberIdentity = identity(key, generation);
    const indexed = memberIdentity && this.membersByIdentity.get(memberIdentity);
    if (!indexed) return null;
    const { group, member, bucketKey } = indexed;
    const wasLeader = group.leader === member;
    group.members = group.members.filter((candidate) => candidate !== member);
    this.membersByIdentity.delete(memberIdentity);
    if (group.members.length === 0) {
      this.#deleteGroup(group, bucketKey);
      return null;
    }
    if (wasLeader) group.leader = group.members[0];
    return { leaderKey: group.leader.key, leaderGeneration: group.leader.generation, promoted: wasLeader };
  }

  members(key, generation = undefined) {
    if (generation === undefined) generation = this.latestGenerationByKey.get(key);
    const memberIdentity = identity(key, generation);
    const indexed = memberIdentity && this.membersByIdentity.get(memberIdentity);
    if (!indexed) return [];
    return indexed.group.members.map((member) => ({ key: member.key, generation: member.generation }));
  }

  #deleteGroup(group, bucketKey) {
    for (const member of group.members) this.membersByIdentity.delete(identity(member.key, member.generation));
    const bucket = this.groupsByFingerprint.get(bucketKey);
    if (!bucket) return;
    const remaining = bucket.filter((candidate) => candidate !== group);
    if (remaining.length) this.groupsByFingerprint.set(bucketKey, remaining);
    else this.groupsByFingerprint.delete(bucketKey);
  }
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function remapAnswers(sourceIds, targetIds, answers) {
  const remapped = {};
  for (let index = 0; index < sourceIds.length; index += 1) {
    const answer = answers[sourceIds[index]];
    if (typeof answer === "string" || Array.isArray(answer) && answer.every((entry) => typeof entry === "string")) remapped[targetIds[index]] = answer;
  }
  return remapped;
}
