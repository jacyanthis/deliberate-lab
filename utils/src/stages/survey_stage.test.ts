import {
  AllocationSurveyAnswer,
  AllocationSurveyQuestion,
  SurveyQuestionKind,
  createAllocationSurveyQuestion,
  formatAllocationValue,
  getAllocationTotal,
  isSurveyAnswerComplete,
  isSurveyComplete,
} from './survey_stage';

const allocationQuestion: AllocationSurveyQuestion = {
  id: 'allocation-q',
  kind: SurveyQuestionKind.ALLOCATION,
  questionTitle: 'Divide the budget.',
  items: [
    {id: 'roads', text: 'Roads'},
    {id: 'schools', text: 'Schools'},
  ],
  totalValue: 100,
  stepSize: 5,
  unitText: '%',
};

function allocationAnswer(
  allocationMap: Record<string, number>,
): AllocationSurveyAnswer {
  return {
    id: allocationQuestion.id,
    kind: SurveyQuestionKind.ALLOCATION,
    allocationMap,
  };
}

describe('createAllocationSurveyQuestion', () => {
  it('should default to a total of 100 in steps of 1', () => {
    const question = createAllocationSurveyQuestion();
    expect(question.kind).toBe(SurveyQuestionKind.ALLOCATION);
    expect(question.totalValue).toBe(100);
    expect(question.stepSize).toBe(1);
    expect(question.unitText).toBe('');
    expect(question.items).toEqual([]);
  });
});

describe('formatAllocationValue', () => {
  it('should separate the number from its unit', () => {
    expect(formatAllocationValue(20, 'Percentage')).toBe('20 Percentage');
    expect(formatAllocationValue(20, 'points')).toBe('20 points');
  });

  it('should show a percent symbol when the question has no unit text', () => {
    expect(formatAllocationValue(20, '')).toBe('20%');
  });
});

describe('getAllocationTotal', () => {
  it('should add up the values of the question items', () => {
    expect(
      getAllocationTotal(
        allocationQuestion,
        allocationAnswer({roads: 60, schools: 40}),
      ),
    ).toBe(100);
  });

  it('should treat a missing item as zero', () => {
    expect(
      getAllocationTotal(allocationQuestion, allocationAnswer({roads: 25})),
    ).toBe(25);
  });

  it('should ignore values for items outside the question', () => {
    expect(
      getAllocationTotal(
        allocationQuestion,
        allocationAnswer({roads: 50, schools: 50, retired: 30}),
      ),
    ).toBe(100);
  });

  it('should return zero without an answer', () => {
    expect(getAllocationTotal(allocationQuestion, undefined)).toBe(0);
  });
});

describe('isSurveyAnswerComplete for allocation questions', () => {
  it('should be complete once the total is allocated', () => {
    const answer = allocationAnswer({roads: 60, schools: 40});
    expect(isSurveyAnswerComplete(answer, allocationQuestion)).toBe(true);
  });

  it('should be incomplete while the allocation falls short', () => {
    const answer = allocationAnswer({roads: 60, schools: 20});
    expect(isSurveyAnswerComplete(answer, allocationQuestion)).toBe(false);
  });

  it('should be incomplete when the allocation runs over', () => {
    const answer = allocationAnswer({roads: 60, schools: 60});
    expect(isSurveyAnswerComplete(answer, allocationQuestion)).toBe(false);
  });

  it('should gate survey completion on the exact total', () => {
    const questions = [allocationQuestion];
    expect(
      isSurveyComplete(questions, {
        'allocation-q': allocationAnswer({roads: 100, schools: 0}),
      }),
    ).toBe(true);
    expect(
      isSurveyComplete(questions, {
        'allocation-q': allocationAnswer({roads: 90, schools: 0}),
      }),
    ).toBe(false);
    expect(isSurveyComplete(questions, {})).toBe(false);
  });
});
