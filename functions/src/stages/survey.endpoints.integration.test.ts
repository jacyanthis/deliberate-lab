/**
 * Integration tests for saving survey stage answers.
 *
 * These cover the path a participant's answers actually take: the endpoint the
 * frontend calls writes the answer document, and the experiment download reads
 * it back. Allocation amounts and per-item checkbox selections live in maps, so
 * the point of these tests is that every entry survives the round trip.
 *
 * This test requires a Firestore emulator running. Run via:
 * npm run test:firestore
 */

import firebaseFunctionsTest from 'firebase-functions-test';
import {
  StageKind,
  SurveyQuestionKind,
  createAllocationItem,
  createAllocationSurveyQuestion,
  createCheckItem,
  createCheckSurveyQuestion,
  createParticipantProfileExtended,
  createSurveyStage,
  createSurveyStageParticipantAnswer,
} from '@deliberation-lab/utils';
import {updateSurveyStageParticipantAnswer} from './survey.endpoints';
import {getExperimentDownload} from '../data';
import {app} from '../app';

const testEnv = firebaseFunctionsTest({projectId: 'demo-deliberate-lab'});
const firestore = app.firestore();

const experimentId = 'survey-answer-test-experiment';
const cohortId = 'survey-answer-test-cohort';
const privateId = 'survey-answer-test-participant';
const publicId = 'participant-public-id';

const budgetItems = [
  createAllocationItem({id: 'item-defense', text: 'Defense'}),
  createAllocationItem({id: 'item-literacy', text: 'Literacy'}),
  createAllocationItem({id: 'item-tools', text: 'Tools'}),
];
const allocationQuestion = createAllocationSurveyQuestion({
  id: 'allocation-question',
  questionTitle: 'Divide the budget',
  items: budgetItems,
  totalValue: 100,
  unitText: '',
});
const checkItems = [
  createCheckItem({id: 'check-email', text: 'Email'}),
  createCheckItem({id: 'check-search', text: 'Search'}),
  createCheckItem({id: 'check-none', text: 'None of these'}),
];
const checkQuestion = createCheckSurveyQuestion({
  id: 'check-question',
  questionTitle: 'Which have you used?',
  items: checkItems,
  maxSelections: 2,
});
const surveyStage = createSurveyStage({
  id: 'survey-stage',
  questions: [allocationQuestion, checkQuestion],
});

/** The answer map the participant view sends once the stage is filled in. */
function buildAnswer() {
  return createSurveyStageParticipantAnswer({
    id: surveyStage.id,
    answerMap: {
      [allocationQuestion.id]: {
        id: allocationQuestion.id,
        kind: SurveyQuestionKind.ALLOCATION,
        // The middle item was left untouched, so it holds nothing
        allocationMap: {'item-defense': 70, 'item-tools': 30},
      },
      [checkQuestion.id]: {
        id: checkQuestion.id,
        kind: SurveyQuestionKind.CHECK,
        isChecked: false,
        checkedMap: {'check-email': true, 'check-search': false},
      },
    },
  });
}

async function saveAnswer(answer: ReturnType<typeof buildAnswer>) {
  const wrapped = testEnv.wrap(updateSurveyStageParticipantAnswer);
  return await wrapped({
    data: {
      experimentId,
      cohortId,
      participantPrivateId: privateId,
      participantPublicId: publicId,
      surveyStageParticipantAnswer: answer,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe('updateSurveyStageParticipantAnswer', () => {
  beforeEach(async () => {
    const experimentRef = firestore.collection('experiments').doc(experimentId);
    await firestore.recursiveDelete(experimentRef);
    await experimentRef.set({
      id: experimentId,
      stageIds: [surveyStage.id],
    });
    await experimentRef
      .collection('stages')
      .doc(surveyStage.id)
      .set(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        surveyStage as any,
      );
    await experimentRef
      .collection('participants')
      .doc(privateId)
      .set(
        createParticipantProfileExtended({
          privateId,
          publicId,
          currentCohortId: cohortId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      );
  });

  afterAll(async () => {
    await firestore.recursiveDelete(
      firestore.collection('experiments').doc(experimentId),
    );
    testEnv.cleanup();
  });

  it('stores the answer map exactly as the participant view sends it', async () => {
    const answer = buildAnswer();
    await saveAnswer(answer);

    const stored = (
      await firestore
        .collection('experiments')
        .doc(experimentId)
        .collection('participants')
        .doc(privateId)
        .collection('stageData')
        .doc(surveyStage.id)
        .get()
    ).data();

    expect(stored).toEqual(answer);
  });

  it('keeps every allocation amount and checkbox selection', async () => {
    await saveAnswer(buildAnswer());

    const stored = (
      await firestore
        .collection('experiments')
        .doc(experimentId)
        .collection('participants')
        .doc(privateId)
        .collection('stageData')
        .doc(surveyStage.id)
        .get()
    ).data();

    const allocation = stored?.answerMap[allocationQuestion.id];
    expect(allocation.allocationMap).toEqual({
      'item-defense': 70,
      'item-tools': 30,
    });
    const check = stored?.answerMap[checkQuestion.id];
    expect(check.checkedMap).toEqual({
      'check-email': true,
      'check-search': false,
    });
  });

  it('replaces the whole answer map when the participant edits an amount', async () => {
    await saveAnswer(buildAnswer());

    const edited = buildAnswer();
    edited.answerMap[allocationQuestion.id] = {
      id: allocationQuestion.id,
      kind: SurveyQuestionKind.ALLOCATION,
      allocationMap: {
        'item-defense': 50,
        'item-literacy': 20,
        'item-tools': 30,
      },
    };
    await saveAnswer(edited);

    const stored = (
      await firestore
        .collection('experiments')
        .doc(experimentId)
        .collection('participants')
        .doc(privateId)
        .collection('stageData')
        .doc(surveyStage.id)
        .get()
    ).data();

    expect(stored?.answerMap[allocationQuestion.id].allocationMap).toEqual({
      'item-defense': 50,
      'item-literacy': 20,
      'item-tools': 30,
    });
  });

  it('rejects an answer that is not one of the question kinds', async () => {
    const answer = buildAnswer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (answer.answerMap[allocationQuestion.id] as any).allocationMap =
      'all of it';

    await expect(saveAnswer(answer)).rejects.toThrow();
  });

  it('carries the answers into the experiment download', async () => {
    await saveAnswer(buildAnswer());

    const download = await getExperimentDownload(firestore, experimentId);
    const participant = download?.participantMap[publicId];
    const answer = participant?.answerMap[surveyStage.id];

    expect(answer?.kind).toEqual(StageKind.SURVEY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answerMap = (answer as any).answerMap;
    expect(answerMap[allocationQuestion.id].allocationMap).toEqual({
      'item-defense': 70,
      'item-tools': 30,
    });
    expect(answerMap[checkQuestion.id].checkedMap).toEqual({
      'check-email': true,
      'check-search': false,
    });
  });
});
