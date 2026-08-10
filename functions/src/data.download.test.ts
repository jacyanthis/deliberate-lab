// This test assumes that a Firestore emulator is running, either at the port
// specified by the FIRESTORE_EMULATOR_HOST environment variable, or at 8081 if
// not specified. npm test is configured to set up a temporary emulator to run
// the test. To do it yourself, run e.g.:
//
// firebase emulators:exec --only firestore "npx jest src/data.download.test.ts"

import {
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {StageKind} from '@deliberation-lab/utils';
import {getExperimentDownload} from './data';

const RULES = `
rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
match /{document=**} {
allow read, write: if true;
}
}
}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockFirestore: any;

describe('getExperimentDownload with the fast option', () => {
  let testEnv: RulesTestEnvironment;

  const experimentId = 'test-experiment';
  const surveyStageId = 'survey-stage';
  const chatStageId = 'chat-stage';
  const interviewStageId = 'interview-stage';
  const stageIds = [surveyStageId, interviewStageId, chatStageId];

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'deliberate-lab-download-test',
      firestore: {
        rules: RULES,
        ...(!process.env.FIRESTORE_EMULATOR_HOST && {
          host: 'localhost',
          port: 8081,
        }),
      },
    });
    mockFirestore = testEnv.unauthenticatedContext().firestore();
    mockFirestore.settings({ignoreUndefinedProperties: true, merge: true});
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  const experiment = () =>
    mockFirestore.collection('experiments').doc(experimentId);

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await experiment().set({
      id: experimentId,
      name: 'Test Experiment',
      stageIds,
    });

    for (const [id, kind] of [
      [surveyStageId, StageKind.SURVEY],
      [interviewStageId, StageKind.PRIVATE_CHAT],
      [chatStageId, StageKind.CHAT],
    ] as const) {
      await experiment().collection('stages').doc(id).set({id, kind, name: id});
    }

    // Two humans and two spawned agents, enough that the fast path runs its
    // batching and its skip over agents.
    for (let index = 0; index < 2; index++) {
      const privateId = `human-${index}`;
      await experiment()
        .collection('participants')
        .doc(privateId)
        .set({
          privateId,
          publicId: `human-public-${index}`,
          name: `Human ${index}`,
        });
      const stageData = experiment()
        .collection('participants')
        .doc(privateId)
        .collection('stageData');
      await stageData.doc(surveyStageId).set({
        id: surveyStageId,
        kind: StageKind.SURVEY,
        answerMap: {q1: {id: 'q1', kind: 'scale', value: index + 1}},
      });
      await stageData
        .doc(chatStageId)
        .collection('thoughts')
        .doc(`thought-${index}`)
        .set({
          id: `thought-${index}`,
          text: `thought ${index}`,
          rating: index + 3,
          timestamp: new Date(2026, 0, 1, 0, index),
        });
      await stageData
        .doc(interviewStageId)
        .collection('privateChats')
        .doc(`message-${index}`)
        .set({
          id: `message-${index}`,
          message: `interview message ${index}`,
          timestamp: new Date(2026, 0, 1, 0, index),
        });
    }
    for (let index = 0; index < 2; index++) {
      const privateId = `agent-${index}`;
      await experiment()
        .collection('participants')
        .doc(privateId)
        .set({
          privateId,
          publicId: `agent-public-${index}`,
          name: `Agent ${index}`,
          agentConfig: {agentId: 'persona', promptContext: 'you are someone'},
        });
      await experiment()
        .collection('participants')
        .doc(privateId)
        .collection('stageData')
        .doc(surveyStageId)
        .set({
          id: surveyStageId,
          kind: StageKind.SURVEY,
          answerMap: {q1: {id: 'q1', kind: 'scale', value: 5}},
        });
    }

    // Two cohorts, each with a chat stage carrying messages and a survey stage
    // carrying none.
    for (let index = 0; index < 2; index++) {
      const cohortId = `cohort-${index}`;
      await experiment()
        .collection('cohorts')
        .doc(cohortId)
        .set({id: cohortId});
      const publicData = experiment()
        .collection('cohorts')
        .doc(cohortId)
        .collection('publicStageData');
      await publicData
        .doc(surveyStageId)
        .set({id: surveyStageId, kind: StageKind.SURVEY});
      await publicData
        .doc(chatStageId)
        .set({id: chatStageId, kind: StageKind.CHAT});
      await publicData
        .doc(chatStageId)
        .collection('chats')
        .doc(`chat-${index}`)
        .set({
          id: `chat-${index}`,
          message: `hello from cohort ${index}`,
          timestamp: new Date(2026, 0, 1, 0, index),
        });
    }
  });

  it('returns exactly what the one-at-a-time walk returns', async () => {
    const slow = await getExperimentDownload(mockFirestore, experimentId);
    const fast = await getExperimentDownload(mockFirestore, experimentId, {
      fast: true,
    });
    expect(fast).toEqual(slow);
    // Key order matters too: the download is often compared as JSON.
    expect(JSON.stringify(fast)).toEqual(JSON.stringify(slow));
  });

  it('keeps the conversation data the download is read for', async () => {
    const fast = await getExperimentDownload(mockFirestore, experimentId, {
      fast: true,
    });
    const human = fast!.participantMap['human-public-0'];
    expect(human.answerMap[surveyStageId]).toBeDefined();
    expect(human.thoughtMap[chatStageId]).toHaveLength(1);
    expect(human.privateChatMap[interviewStageId]).toHaveLength(1);
    expect(fast!.cohortMap['cohort-1'].chatMap[chatStageId]).toHaveLength(1);
    expect(
      fast!.participantMap['agent-public-0'].answerMap[surveyStageId],
    ).toBeDefined();
  });
});
