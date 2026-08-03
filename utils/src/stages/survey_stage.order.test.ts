import {getSurveyQuestionDisplayOrder} from './survey_stage';

const items = [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}];
const ids = (x: {id: string}[]) => x.map((i) => i.id).join('');

describe('getSurveyQuestionDisplayOrder', () => {
  it('leaves order alone unless randomization is on', () => {
    expect(ids(getSurveyQuestionDisplayOrder(items, {}, 's1', 'p1'))).toBe(
      'abcd',
    );
    expect(
      ids(
        getSurveyQuestionDisplayOrder(
          items,
          {randomizeOrder: false},
          's1',
          'p1',
        ),
      ),
    ).toBe('abcd');
  });

  it('is stable for a participant within a stage', () => {
    const q = {randomizeOrder: true};
    const first = ids(getSurveyQuestionDisplayOrder(items, q, 's1', 'p1'));
    expect(ids(getSurveyQuestionDisplayOrder(items, q, 's1', 'p1'))).toBe(
      first,
    );
  });

  it('differs by round and by participant', () => {
    const q = {randomizeOrder: true};
    const p1s1 = ids(getSurveyQuestionDisplayOrder(items, q, 's1', 'p1'));
    const p1s2 = ids(getSurveyQuestionDisplayOrder(items, q, 's2', 'p1'));
    const p2s1 = ids(getSurveyQuestionDisplayOrder(items, q, 's1', 'p2'));
    expect(p1s1).not.toBe(p1s2);
    expect(p1s1).not.toBe(p2s1);
  });

  it('holds one order across stages that share a key', () => {
    const q = {randomizeOrder: true, randomizeOrderKey: 'round-0'};
    expect(ids(getSurveyQuestionDisplayOrder(items, q, 's1', 'p1'))).toBe(
      ids(getSurveyQuestionDisplayOrder(items, q, 's2', 'p1')),
    );
  });

  it('keeps every item exactly once', () => {
    const out = getSurveyQuestionDisplayOrder(
      items,
      {randomizeOrder: true},
      's1',
      'p1',
    );
    expect(out).toHaveLength(items.length);
    expect(ids(out).split('').sort().join('')).toBe('abcd');
  });

  it('falls back to config order with no participant', () => {
    expect(
      ids(
        getSurveyQuestionDisplayOrder(items, {randomizeOrder: true}, 's1', ''),
      ),
    ).toBe('abcd');
  });
});
