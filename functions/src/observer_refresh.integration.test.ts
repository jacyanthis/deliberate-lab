/**
 * The same stuck cohort, driven through the endpoint the participant's
 * "Refresh this stage" button calls, rather than the internal helper.
 *
 * This test requires a Firestore emulator running. Run via:
 * npm run test:firestore
 */

import {app} from './app';
import {Timestamp} from 'firebase-admin/firestore';
import {
  CohortConfig,
  ParticipantProfileExtended,
  ParticipantStatus,
  createChatStage,
  createCohortConfig,
  createMetadataConfig,
  createParticipantProfileExtended,
  createStageProgressConfig,
  generateId,
} from '@deliberation-lab/utils';
import {updateCohortStageUnlocked} from './participant.utils';

const firestore = app.firestore();

function serialize<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

/** What updateParticipantWaiting does: stamp the stage, then try the unlock. */
async function pressRefreshThisStage(
  experimentId: string,
  privateId: string,
  stageId: string,
) {
  const document = firestore.doc(
    `experiments/${experimentId}/participants/${privateId}`,
  );
  await firestore.runTransaction(async (transaction) => {
    const participant = (
      await document.get()
    ).data() as ParticipantProfileExtended;
    participant.timestamps.readyStages[stageId] = Timestamp.now();

    await updateCohortStageUnlocked(
      experimentId,
      participant.currentCohortId,
      participant.currentStageId,
      participant.privateId,
      transaction,
    );

    transaction.set(document, participant);
  });
}

describe('the stuck cohort, driven the way a participant would', () => {
  it('unlocks the chat and stamps the participant', async () => {
    const chatStage = createChatStage({
      id: generateId(),
      isTurnBased: true,
      progress: createStageProgressConfig({
        minParticipants: 1,
        waitForAllParticipants: false,
      }),
    });
    const experimentId = generateId();
    const cohortId = generateId();

    await firestore
      .collection('experiments')
      .doc(experimentId)
      .set({
        id: experimentId,
        metadata: {name: 'Refresh test'},
        stageIds: [chatStage.id],
        defaultCohortConfig: {},
        variableConfigs: [],
        cohortDefinitions: [],
      });
    await firestore
      .collection(`experiments/${experimentId}/stages`)
      .doc(chatStage.id)
      .set(serialize(chatStage));
    const timestamp = Timestamp.now();
    await firestore
      .collection(`experiments/${experimentId}/cohorts`)
      .doc(cohortId)
      .set(
        createCohortConfig({
          id: cohortId,
          metadata: {
            ...createMetadataConfig({name: 'Cohort'}),
            dateCreated: timestamp,
            dateModified: timestamp,
          },
        }),
      );

    // One observer, arrived but never marked ready, plus four inactive
    // personas: the composition of the cohorts that hung.
    const observerId = generateId();
    const observer = createParticipantProfileExtended({
      privateId: observerId,
      publicId: `pub-${observerId}`,
      currentCohortId: cohortId,
      currentStageId: chatStage.id,
      currentStatus: ParticipantStatus.IN_PROGRESS,
    });
    observer.isObserver = true;
    observer.timestamps.startExperiment = Timestamp.now();
    await firestore
      .collection(`experiments/${experimentId}/participants`)
      .doc(observerId)
      .set(serialize(observer));

    for (let index = 0; index < 4; index++) {
      const agentId = generateId();
      const agent = createParticipantProfileExtended({
        privateId: agentId,
        publicId: `pub-${agentId}`,
        currentCohortId: cohortId,
        currentStageId: chatStage.id,
        currentStatus: ParticipantStatus.IN_PROGRESS,
      });
      agent.agentConfig = {
        agentId: 'agent',
        promptContext: '',
        modelSettings: {apiType: 'GEMINI_API_KEY', modelName: 'test'},
        needsPersonaGeneration: false,
        isInactivePersona: true,
      } as ParticipantProfileExtended['agentConfig'];
      agent.timestamps.startExperiment = Timestamp.now();
      agent.timestamps.readyStages[chatStage.id] = Timestamp.now();
      await firestore
        .collection(`experiments/${experimentId}/participants`)
        .doc(agentId)
        .set(serialize(agent));
    }

    await pressRefreshThisStage(experimentId, observerId, chatStage.id);

    const cohort = (
      await firestore
        .doc(`experiments/${experimentId}/cohorts/${cohortId}`)
        .get()
    ).data() as CohortConfig;
    const stamped = (
      await firestore
        .doc(`experiments/${experimentId}/participants/${observerId}`)
        .get()
    ).data() as ParticipantProfileExtended;

    expect(cohort.stageUnlockMap[chatStage.id]).toBe(true);
    expect(stamped.timestamps.readyStages[chatStage.id]).toBeTruthy();
  });
});
