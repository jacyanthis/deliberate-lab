/**
 * Integration tests for two ways a chat can go wrong for an observer.
 *
 * 1. A cohort holding one observer and only inactive personas never unlocks
 *    its chat stage, so the chat never starts.
 * 2. A chat that times out after the participant has moved on blocks them on
 *    whatever page they have reached.
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
  createPrivateChatStage,
  createStageProgressConfig,
  createSurveyStage,
  generateId,
} from '@deliberation-lab/utils';
import {updateCohortStageUnlocked} from './participant.utils';
import {markTurnBasedApiFailure} from './chat/chat.agent';

const firestore = app.firestore();

function serialize<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

async function writeExperiment(experimentId: string, stageIds: string[]) {
  await firestore
    .collection('experiments')
    .doc(experimentId)
    .set({
      id: experimentId,
      metadata: {name: 'Observer chat test'},
      stageIds,
      defaultCohortConfig: {},
      variableConfigs: [],
      cohortDefinitions: [],
    });
}

async function writeStage(experimentId: string, stage: object) {
  await firestore
    .collection(`experiments/${experimentId}/stages`)
    .doc((stage as {id: string}).id)
    .set(serialize(stage));
}

async function writeCohort(experimentId: string, cohortId: string) {
  const timestamp = Timestamp.now();
  const cohort = createCohortConfig({
    id: cohortId,
    metadata: {
      ...createMetadataConfig({name: 'Cohort'}),
      dateCreated: timestamp,
      dateModified: timestamp,
    },
  });
  await firestore
    .collection(`experiments/${experimentId}/cohorts`)
    .doc(cohortId)
    .set(cohort);
}

async function readCohort(
  experimentId: string,
  cohortId: string,
): Promise<CohortConfig> {
  const doc = await firestore
    .doc(`experiments/${experimentId}/cohorts/${cohortId}`)
    .get();
  return doc.data() as CohortConfig;
}

async function writeParticipant(
  experimentId: string,
  cohortId: string,
  stageId: string,
  options: {
    isObserver?: boolean;
    inactivePersona?: boolean;
    ready?: boolean;
  } = {},
): Promise<ParticipantProfileExtended> {
  const privateId = generateId();
  const participant = createParticipantProfileExtended({
    privateId,
    publicId: `pub-${privateId}`,
    currentCohortId: cohortId,
    currentStageId: stageId,
    currentStatus: ParticipantStatus.IN_PROGRESS,
  });
  participant.isObserver = options.isObserver ?? false;
  if (options.inactivePersona) {
    participant.agentConfig = {
      agentId: 'agent',
      promptContext: '',
      modelSettings: {
        apiType: 'GEMINI_API_KEY',
        modelName: 'test',
      },
      needsPersonaGeneration: false,
      isInactivePersona: true,
    } as ParticipantProfileExtended['agentConfig'];
  }
  if (options.ready !== false) {
    participant.timestamps.startExperiment = Timestamp.now();
    participant.timestamps.readyStages[stageId] = Timestamp.now();
  }
  await firestore
    .collection(`experiments/${experimentId}/participants`)
    .doc(privateId)
    .set(serialize(participant));
  return participant;
}

async function readStatus(experimentId: string, privateId: string) {
  const doc = await firestore
    .doc(`experiments/${experimentId}/participants/${privateId}`)
    .get();
  return (doc.data() as ParticipantProfileExtended).currentStatus;
}

describe('unlocking a chat stage for a cohort whose only human observes', () => {
  const chatStage = createChatStage({
    id: generateId(),
    isTurnBased: true,
    progress: createStageProgressConfig({
      minParticipants: 1,
      waitForAllParticipants: false,
    }),
  });

  it('unlocks with one observer and four inactive personas', async () => {
    const experimentId = generateId();
    const cohortId = generateId();
    await writeExperiment(experimentId, [chatStage.id]);
    await writeStage(experimentId, chatStage);
    await writeCohort(experimentId, cohortId);
    const observer = await writeParticipant(
      experimentId,
      cohortId,
      chatStage.id,
      {isObserver: true},
    );
    for (let index = 0; index < 4; index++) {
      await writeParticipant(experimentId, cohortId, chatStage.id, {
        inactivePersona: true,
      });
    }

    await updateCohortStageUnlocked(
      experimentId,
      cohortId,
      chatStage.id,
      observer.privateId,
    );

    const cohort = await readCohort(experimentId, cohortId);
    expect(cohort.stageUnlockMap[chatStage.id]).toBe(true);
  });

  it('still waits for an observer who has not reached the stage', async () => {
    const waitStage = createChatStage({
      id: generateId(),
      isTurnBased: true,
      progress: createStageProgressConfig({
        minParticipants: 1,
        waitForAllParticipants: true,
      }),
    });
    const experimentId = generateId();
    const cohortId = generateId();
    await writeExperiment(experimentId, [waitStage.id]);
    await writeStage(experimentId, waitStage);
    await writeCohort(experimentId, cohortId);
    const present = await writeParticipant(
      experimentId,
      cohortId,
      waitStage.id,
      {isObserver: true},
    );
    await writeParticipant(experimentId, cohortId, waitStage.id, {
      isObserver: true,
      ready: false,
    });

    await updateCohortStageUnlocked(
      experimentId,
      cohortId,
      waitStage.id,
      present.privateId,
    );

    const cohort = await readCohort(experimentId, cohortId);
    expect(cohort.stageUnlockMap[waitStage.id]).toBeUndefined();
  });

  it('keeps an unlock that lands while another one is being written', async () => {
    const other = createChatStage({
      id: generateId(),
      isTurnBased: true,
      progress: createStageProgressConfig({
        minParticipants: 1,
        waitForAllParticipants: false,
      }),
    });
    const experimentId = generateId();
    const cohortId = generateId();
    await writeExperiment(experimentId, [chatStage.id, other.id]);
    await writeStage(experimentId, chatStage);
    await writeStage(experimentId, other);
    await writeCohort(experimentId, cohortId);
    const first = await writeParticipant(experimentId, cohortId, chatStage.id, {
      isObserver: true,
    });
    const second = await writeParticipant(experimentId, cohortId, other.id, {
      isObserver: true,
    });

    await Promise.all([
      updateCohortStageUnlocked(
        experimentId,
        cohortId,
        chatStage.id,
        first.privateId,
      ),
      updateCohortStageUnlocked(
        experimentId,
        cohortId,
        other.id,
        second.privateId,
      ),
    ]);

    const cohort = await readCohort(experimentId, cohortId);
    expect(cohort.stageUnlockMap[chatStage.id]).toBe(true);
    expect(cohort.stageUnlockMap[other.id]).toBe(true);
  });
});

describe('blocking a participant when a turn-based chat gives up', () => {
  const privateChat = createPrivateChatStage({id: generateId()});
  const groupChat = createChatStage({id: generateId(), isTurnBased: true});
  const survey = createSurveyStage({id: generateId()});

  async function setUp() {
    const experimentId = generateId();
    const cohortId = generateId();
    await writeExperiment(experimentId, [
      privateChat.id,
      groupChat.id,
      survey.id,
    ]);
    await writeStage(experimentId, privateChat);
    await writeStage(experimentId, groupChat);
    await writeStage(experimentId, survey);
    await writeCohort(experimentId, cohortId);
    return {experimentId, cohortId};
  }

  it('leaves alone a participant who has left the private chat', async () => {
    const {experimentId, cohortId} = await setUp();
    const participant = await writeParticipant(
      experimentId,
      cohortId,
      survey.id,
    );

    await markTurnBasedApiFailure(experimentId, cohortId, privateChat, [
      participant.privateId,
    ]);

    expect(await readStatus(experimentId, participant.privateId)).toBe(
      ParticipantStatus.IN_PROGRESS,
    );
  });

  it('blocks a participant who is still in the private chat', async () => {
    const {experimentId, cohortId} = await setUp();
    const participant = await writeParticipant(
      experimentId,
      cohortId,
      privateChat.id,
    );

    await markTurnBasedApiFailure(experimentId, cohortId, privateChat, [
      participant.privateId,
    ]);

    expect(await readStatus(experimentId, participant.privateId)).toBe(
      ParticipantStatus.API_FAILURE,
    );
  });

  it('blocks a participant who is still in the group chat', async () => {
    const {experimentId, cohortId} = await setUp();
    const participant = await writeParticipant(
      experimentId,
      cohortId,
      groupChat.id,
    );

    await markTurnBasedApiFailure(experimentId, cohortId, groupChat, []);

    expect(await readStatus(experimentId, participant.privateId)).toBe(
      ParticipantStatus.API_FAILURE,
    );
  });
});
