import {
  AllocationSurveyAnswer,
  AllocationSurveyQuestion,
  CheckSurveyAnswer,
  CheckSurveyQuestion,
  SurveyQuestionKind,
  createAllocationSurveyQuestion,
  createCheckSurveyQuestion,
  getCheckedItemIds,
  getRemainingCheckSelections,
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

const checkQuestion: CheckSurveyQuestion = {
  id: 'check-q',
  kind: SurveyQuestionKind.CHECK,
  questionTitle: 'Which of these do you use?',
  isRequired: false,
  items: [
    {id: 'radio', text: 'Radio'},
    {id: 'papers', text: 'Papers'},
    {id: 'letters', text: 'Letters'},
  ],
  maxSelections: null,
};

function checkAnswer(checkedMap: Record<string, boolean>): CheckSurveyAnswer {
  return {
    id: checkQuestion.id,
    kind: SurveyQuestionKind.CHECK,
    isChecked: Object.values(checkedMap).some((checked) => checked),
    checkedMap,
  };
}

describe('createCheckSurveyQuestion', () => {
  it('should default to a single checkbox with no selection limit', () => {
    const question = createCheckSurveyQuestion();
    expect(question.items).toEqual([]);
    expect(question.maxSelections).toBeNull();
    expect(question.isRequired).toBe(false);
  });
});

describe('getCheckedItemIds', () => {
  it('should list the checked items in question order', () => {
    expect(
      getCheckedItemIds(
        checkQuestion,
        checkAnswer({letters: true, radio: true}),
      ),
    ).toEqual(['radio', 'letters']);
  });

  it('should ignore items the question no longer has', () => {
    expect(
      getCheckedItemIds(checkQuestion, checkAnswer({radio: true, fax: true})),
    ).toEqual(['radio']);
  });

  it('should return nothing without an answer', () => {
    expect(getCheckedItemIds(checkQuestion, undefined)).toEqual([]);
  });
});

describe('getRemainingCheckSelections', () => {
  it('should count down from the limit', () => {
    const question = {...checkQuestion, maxSelections: 2};
    expect(getRemainingCheckSelections(question, undefined)).toBe(2);
    expect(
      getRemainingCheckSelections(question, checkAnswer({radio: true})),
    ).toBe(1);
    expect(
      getRemainingCheckSelections(
        question,
        checkAnswer({radio: true, papers: true}),
      ),
    ).toBe(0);
  });

  it('should treat a limit of at least the item count as no limit', () => {
    expect(
      getRemainingCheckSelections(
        {...checkQuestion, maxSelections: 3},
        undefined,
      ),
    ).toBeNull();
    expect(
      getRemainingCheckSelections(
        {...checkQuestion, maxSelections: 9},
        undefined,
      ),
    ).toBeNull();
  });

  it('should treat an absent limit as no limit', () => {
    expect(getRemainingCheckSelections(checkQuestion, undefined)).toBeNull();
  });
});

describe('isSurveyAnswerComplete for checkbox questions', () => {
  it('should be complete once an item is checked', () => {
    const required = {...checkQuestion, isRequired: true};
    expect(isSurveyAnswerComplete(checkAnswer({radio: true}), required)).toBe(
      true,
    );
    expect(isSurveyAnswerComplete(checkAnswer({}), required)).toBe(false);
  });

  it('should leave the single checkbox behavior alone', () => {
    const single = createCheckSurveyQuestion({
      questionTitle: 'Agree?',
      isRequired: true,
    });
    const answer: CheckSurveyAnswer = {
      id: single.id,
      kind: SurveyQuestionKind.CHECK,
      isChecked: true,
    };
    expect(isSurveyAnswerComplete(answer, single)).toBe(true);
    expect(isSurveyAnswerComplete({...answer, isChecked: false}, single)).toBe(
      false,
    );
  });

  it('should not require an optional item question', () => {
    expect(isSurveyComplete([checkQuestion], {})).toBe(true);
  });
});
