/**
 * Integration test for accepting a transfer twice at the same moment.
 *
 * The frontend accepts a pending transfer on the participant's behalf, from a
 * reaction that fires as soon as the transfer is raised. The guard against
 * running it twice is per component instance, so a second view of the same
 * participant, a second tab or a remount, issues its own accept while the
 * first is still in flight. Completing the transfer spawns the round's agent
 * participants, so completing it twice fills the cohort with two groups: this
 * is what left one real cohort holding nine representatives instead of five,
 * with the same participant's own representative twice in the turn order.
 *
 * The endpoint holds a transaction over the participant document, so the two
 * callers serialise: one commits, the other retries, sees transferCohortId
 * cleared and does nothing. That only works because the document is read
 * through the transaction; a plain get registers no read on it and both
 * callers commit.
 *
 * This test requires a Firestore emulator running. Run via:
 * npm run test:firestore
 */

import firebaseFunctionsTest from 'firebase-functions-test';
import {Timestamp} from 'firebase-admin/firestore';
import {
  ParticipantStatus,
  createChatStage,
  createCohortConfig,
  createMetadataConfig,
  createParticipantProfileExtended,
  createTransferStage,
} from '@deliberation-lab/utils';
import {acceptParticipantTransfer} from './participant.endpoints';
import {app} from './app';

const testEnv = firebaseFunctionsTest({projectId: 'demo-deliberate-lab'});
const firestore = app.firestore();

const experimentId = 'accept-transfer-test-experiment';
const fromCohortId = 'accept-transfer-test-cohort-from';
const toCohortId = 'accept-transfer-test-cohort-to';
const privateId = 'accept-transfer-test-participant';
const publicId = 'otter-orange-1234';

const transferStage = createTransferStage({
  id: 'transfer-stage',
  name: 'Transfer',
});
const chatStage = createChatStage({
  id: 'chat-stage',
  name: 'Group chat',
});
const stageIds = [transferStage.id, chatStage.id];

function serialize<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

async function seed() {
  await firestore
    .collection('experiments')
    .doc(experimentId)
    .set({
      id: experimentId,
      metadata: {name: 'Accept transfer test'},
      stageIds,
      defaultCohortConfig: {},
      variableConfigs: [],
      cohortDefinitions: [],
    });
  for (const stage of [transferStage, chatStage]) {
    await firestore
      .collection(`experiments/${experimentId}/stages`)
      .doc(stage.id)
      .set(serialize(stage));
  }
  for (const cohortId of [fromCohortId, toCohortId]) {
    const timestamp = Timestamp.now();
    await firestore
      .collection(`experiments/${experimentId}/cohorts`)
      .doc(cohortId)
      .set(
        createCohortConfig({
          id: cohortId,
          metadata: {
            ...createMetadataConfig({name: cohortId}),
            dateCreated: timestamp,
            dateModified: timestamp,
          },
        }),
      );
  }
  const participant = createParticipantProfileExtended({
    privateId,
    publicId,
    currentCohortId: fromCohortId,
    currentStageId: transferStage.id,
    currentStatus: ParticipantStatus.TRANSFER_PENDING,
  });
  participant.transferCohortId = toCohortId;
  // The round spawns four other agents, as the study did.
  participant.otherAgentGeneration = {numOtherAgents: 4};
  await firestore
    .collection(`experiments/${experimentId}/participants`)
    .doc(privateId)
    .set(serialize(participant));
}

async function spawnedInTargetCohort() {
  const snapshot = await firestore
    .collection(`experiments/${experimentId}/participants`)
    .where('currentCohortId', '==', toCohortId)
    .get();
  return snapshot.docs
    .map((doc) => doc.data() as {publicId: string; agentConfig?: unknown})
    .filter((p) => p.agentConfig);
}

async function clear() {
  const collections = [
    `experiments/${experimentId}/participants`,
    `experiments/${experimentId}/stages`,
    `experiments/${experimentId}/cohorts`,
  ];
  for (const path of collections) {
    const snapshot = await firestore.collection(path).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
  await firestore.collection('experiments').doc(experimentId).delete();
}

describe('accepting a transfer twice at once', () => {
  beforeEach(async () => {
    await clear();
    await seed();
  });

  afterAll(async () => {
    await clear();
    testEnv.cleanup();
  });

  it('spawns the round once when two accepts arrive together', async () => {
    const wrapped = testEnv.wrap(acceptParticipantTransfer);
    const call = () =>
      wrapped({
        data: {experimentId, participantId: privateId},
      } as never);

    const results = await Promise.allSettled([call(), call()]);
    const rejected = results.filter((r) => r.status === 'rejected');
    // Whichever call loses the race is expected to return, not to throw.
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);

    const agents = await spawnedInTargetCohort();
    expect(agents.length).toBe(4);
    expect(new Set(agents.map((a) => a.publicId)).size).toBe(agents.length);

    const participant = (
      await firestore
        .collection(`experiments/${experimentId}/participants`)
        .doc(privateId)
        .get()
    ).data() as {currentCohortId: string; transferCohortId: string | null};
    expect(participant.currentCohortId).toBe(toCohortId);
    expect(participant.transferCohortId).toBeNull();
  });

  it('spawns the round once when the second accept arrives afterwards', async () => {
    const wrapped = testEnv.wrap(acceptParticipantTransfer);
    await wrapped({data: {experimentId, participantId: privateId}} as never);
    await wrapped({data: {experimentId, participantId: privateId}} as never);

    const agents = await spawnedInTargetCohort();
    expect(agents.length).toBe(4);
  });
});
