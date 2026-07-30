/**
 * Condition utilities for resolving target values from stage answers.
 *
 * This module provides functions to extract condition target values from
 * various stage answer data structures, enabling condition evaluation
 * across different contexts (survey display, prompt building, transfers, etc).
 */

import {
  ConditionTargetReference,
  getConditionTargetKey,
  extractMultipleConditionDependencies,
  extractConditionDependencies,
  evaluateCondition,
  Condition,
} from './condition';
import {StageKind, StageConfig, StageParticipantAnswer} from '../stages/stage';
import {
  SurveyStageConfig,
  SurveyPerParticipantStageConfig,
  SurveyStageParticipantAnswer,
  SurveyPerParticipantStageParticipantAnswer,
  SurveyAnswer,
  SurveyQuestion,
  SurveyQuestionKind,
  CheckSurveyAnswer,
  MultipleChoiceSurveyQuestion,
  extractAnswerValue,
} from '../stages/survey_stage';

/** Returns every condition target value a survey answer provides: the answer
 *  itself, plus one entry per checked-off item for a checkbox that has items.
 *  For callers that hold answers and need the whole set of keys up front, such
 *  as transfer group composition. Callers that already know which target they
 *  want read it through extractTargetValue instead, and the two agree on the
 *  key each value is stored under.
 */
export function getTargetValuesForAnswer(
  stageId: string,
  questionId: string,
  answer: SurveyAnswer,
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    [getConditionTargetKey({stageId, questionId})]: extractAnswerValue(answer),
  };

  if (answer.kind === SurveyQuestionKind.CHECK) {
    const checkedMap = (answer as CheckSurveyAnswer).checkedMap ?? {};
    for (const itemId of Object.keys(checkedMap)) {
      const key = getConditionTargetKey({stageId, questionId, itemId});
      values[key] = checkedMap[itemId] === true;
    }
  }

  return values;
}

/** Read the value a target refers to, following itemId into a checkbox map. */
function extractTargetValue(
  answer: SurveyAnswer,
  target: ConditionTargetReference,
): unknown {
  if (target.itemId && answer.kind === SurveyQuestionKind.CHECK) {
    const checkAnswer = answer as CheckSurveyAnswer;
    return checkAnswer.checkedMap?.[target.itemId] === true;
  }
  return extractAnswerValue(answer);
}

/**
 * Get condition dependency values from a map of stage answers.
 *
 * This is the primary utility for getting condition values from completed stage answers.
 * It handles both regular Survey stages and SurveyPerParticipant stages.
 *
 * @param dependencies - The condition target references to resolve
 * @param stageAnswers - Map of stageId to StageParticipantAnswer
 * @param targetParticipantId - For SurveyPerParticipant stages, which participant's answers to use
 * @returns Map of target keys (stageId::questionId) to their resolved values
 */
export function getConditionDependencyValues(
  dependencies: ConditionTargetReference[],
  stageAnswers: Record<string, StageParticipantAnswer>,
  targetParticipantId?: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const targetRef of dependencies) {
    const dataKey = getConditionTargetKey(targetRef);
    const stageAnswer = stageAnswers[targetRef.stageId];

    if (!stageAnswer || !('answerMap' in stageAnswer)) {
      continue;
    }

    if (stageAnswer.kind === StageKind.SURVEY) {
      const surveyAnswer = stageAnswer as SurveyStageParticipantAnswer;
      const answer = surveyAnswer.answerMap[targetRef.questionId];
      if (answer) {
        values[dataKey] = extractTargetValue(answer, targetRef);
      }
    } else if (stageAnswer.kind === StageKind.SURVEY_PER_PARTICIPANT) {
      // For SurveyPerParticipant stages, we need targetParticipantId to know which answer to use
      if (targetParticipantId) {
        const surveyAnswer =
          stageAnswer as SurveyPerParticipantStageParticipantAnswer;
        const participantAnswers = surveyAnswer.answerMap[targetRef.questionId];
        if (participantAnswers && participantAnswers[targetParticipantId]) {
          values[dataKey] = extractTargetValue(
            participantAnswers[targetParticipantId],
            targetRef,
          );
        }
      }
    }
  }

  return values;
}

/**
 * Get condition dependency values, including current stage answers that may not be persisted yet.
 *
 * Use this when evaluating conditions during active survey completion, where the current
 * stage's answers are in a local map (not yet saved to Firestore).
 *
 * @param dependencies - The condition target references to resolve
 * @param currentStageId - The ID of the stage currently being worked on
 * @param currentStageAnswers - Map of questionId to SurveyAnswer for the current stage
 * @param allStageAnswers - Map of stageId to StageParticipantAnswer for other stages
 * @param targetParticipantId - For SurveyPerParticipant stages, which participant's answers to use
 */
export function getConditionDependencyValuesWithCurrentStage(
  dependencies: ConditionTargetReference[],
  currentStageId: string,
  currentStageAnswers: Record<string, SurveyAnswer>,
  allStageAnswers?: Record<string, StageParticipantAnswer>,
  targetParticipantId?: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const targetRef of dependencies) {
    const dataKey = getConditionTargetKey(targetRef);

    if (targetRef.stageId === currentStageId) {
      // Reference to current stage - use local answers
      const answer = currentStageAnswers[targetRef.questionId];
      if (answer) {
        values[dataKey] = extractTargetValue(answer, targetRef);
      }
    } else if (allStageAnswers) {
      // Reference to another stage - use persisted answers
      const stageValues = getConditionDependencyValues(
        [targetRef],
        allStageAnswers,
        targetParticipantId,
      );
      Object.assign(values, stageValues);
    }
  }

  return values;
}

/**
 * Evaluate a condition against stage answers.
 *
 * Convenience function that combines dependency extraction, value resolution,
 * and condition evaluation in one call.
 *
 * @param condition - The condition to evaluate
 * @param stageAnswers - Map of stageId to StageParticipantAnswer
 * @param targetParticipantId - For SurveyPerParticipant stages, which participant's answers to use
 * @returns true if condition passes (or if condition is undefined)
 */
export function evaluateConditionWithStageAnswers(
  condition: Condition | undefined,
  stageAnswers: Record<string, StageParticipantAnswer>,
  targetParticipantId?: string,
): boolean {
  if (!condition) return true;

  const dependencies = extractMultipleConditionDependencies([condition]);
  const targetValues = getConditionDependencyValues(
    dependencies,
    stageAnswers,
    targetParticipantId,
  );

  return evaluateCondition(condition, targetValues);
}

/**
 * Filter items with conditions based on stage answers.
 *
 * Generic utility to filter any array of items that have optional conditions.
 *
 * @param items - Array of items, each potentially having a `condition` property
 * @param stageAnswers - Map of stageId to StageParticipantAnswer
 * @param targetParticipantId - For SurveyPerParticipant stages, which participant's answers to use
 * @returns Filtered array containing only items whose conditions pass
 */
export function filterByCondition<T extends {condition?: Condition}>(
  items: T[],
  stageAnswers: Record<string, StageParticipantAnswer>,
  targetParticipantId?: string,
): T[] {
  // Extract all dependencies upfront for efficiency
  const allConditions = items
    .map((item) => item.condition)
    .filter((c): c is Condition => c !== undefined);

  if (allConditions.length === 0) {
    return items;
  }

  const allDependencies = extractMultipleConditionDependencies(allConditions);
  const targetValues = getConditionDependencyValues(
    allDependencies,
    stageAnswers,
    targetParticipantId,
  );

  return items.filter((item) => {
    if (!item.condition) return true;
    return evaluateCondition(item.condition, targetValues);
  });
}

// ============================================================================
// Condition Target Utilities
// ============================================================================

/**
 * Readable representation of a possible target for a condition.
 * Used to populate dropdowns in condition editors.
 */
export interface ConditionTarget {
  ref: ConditionTargetReference;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'choice';
  choices?: Array<{id: string; label: string}>;
  stageName?: string;
}

/** Convert survey questions to condition targets for the editor UI. */
export function surveyQuestionsToConditionTargets(
  questions: SurveyQuestion[],
  stageId: string,
  stageName?: string,
): ConditionTarget[] {
  // Allocation answers hold a number per item, so they are not offered here
  const targetableQuestions = questions.filter(
    (q) => q.kind !== SurveyQuestionKind.ALLOCATION,
  );

  const targets: ConditionTarget[] = [];

  for (const question of targetableQuestions) {
    // A checkbox question with items offers one boolean target per item
    if (question.kind === SurveyQuestionKind.CHECK && question.items?.length) {
      for (const item of question.items) {
        const questionLabel =
          question.questionTitle || `Question ${question.id}`;
        targets.push({
          ref: {
            stageId: stageId,
            questionId: question.id,
            itemId: item.id,
          },
          label: `${questionLabel}: ${item.text || item.id}`,
          type: 'boolean',
          choices: undefined,
          stageName,
        });
      }
      continue;
    }
    targets.push(buildQuestionTarget(question, stageId, stageName));
  }

  return targets;
}

/** Convert a single survey question to a condition target. */
function buildQuestionTarget(
  q: SurveyQuestion,
  stageId: string,
  stageName?: string,
): ConditionTarget {
  let type: ConditionTarget['type'] = 'text';
  let choices: ConditionTarget['choices'] = undefined;

  switch (q.kind) {
    case SurveyQuestionKind.TEXT:
      type = 'text';
      break;
    case SurveyQuestionKind.CHECK:
      type = 'boolean';
      break;
    case SurveyQuestionKind.SCALE:
      type = 'number';
      break;
    case SurveyQuestionKind.MULTIPLE_CHOICE:
      type = 'choice';
      const mcQuestion = q as MultipleChoiceSurveyQuestion;
      choices = mcQuestion.options.map((opt) => ({
        id: opt.id,
        label: opt.text || `Option ${opt.id}`,
      }));
      break;
  }

  const ref: ConditionTargetReference = {
    stageId: stageId,
    questionId: q.id,
  };

  const label = q.questionTitle || `Question ${q.id}`;

  return {
    ref,
    label,
    type,
    choices,
    stageName,
  };
}

/**
 * Get condition targets from stages preceding (and optionally including) the specified stage.
 *
 * @param stages - All stages in the experiment
 * @param currentStageId - The ID of the current stage
 * @param options - Configuration options
 * @param options.includeCurrentStage - Whether to include the current stage (default: true)
 * @param options.currentStageQuestionIndex - If including current stage, only include questions before this index
 * @returns Array of condition targets from qualifying stages
 */
export function getConditionTargetsFromStages(
  stages: StageConfig[],
  currentStageId: string,
  options: {
    includeCurrentStage?: boolean;
    currentStageQuestionIndex?: number;
  } = {},
): ConditionTarget[] {
  const {includeCurrentStage = true, currentStageQuestionIndex} = options;

  const currentStageIndex = stages.findIndex(
    (stage) => stage.id === currentStageId,
  );

  if (currentStageIndex < 0) {
    return [];
  }

  const targets: ConditionTarget[] = [];

  const endIndex = includeCurrentStage
    ? currentStageIndex + 1
    : currentStageIndex;

  for (let i = 0; i < endIndex; i++) {
    const stage = stages[i];

    if (
      stage.kind === StageKind.SURVEY ||
      stage.kind === StageKind.SURVEY_PER_PARTICIPANT
    ) {
      const surveyStage = stage as
        | SurveyStageConfig
        | SurveyPerParticipantStageConfig;

      let questions = surveyStage.questions;

      // If this is the current stage and we have a question index, slice the questions
      if (i === currentStageIndex && currentStageQuestionIndex !== undefined) {
        questions = questions.slice(0, currentStageQuestionIndex);
      }

      const stageTargets = surveyQuestionsToConditionTargets(
        questions,
        stage.id,
        stage.name,
      );
      targets.push(...stageTargets);
    }
  }

  return targets;
}

/**
 * Sanitize survey question conditions to ensure they only reference valid targets.
 *
 * A condition is invalid if it references:
 * - A question that doesn't exist in the list
 * - A question that comes at or after the current question's position
 * - A checkbox item that the referenced question no longer has
 *
 * Invalid conditions are cleared (set to undefined) to prevent rendering issues.
 *
 * @param questions - The list of survey questions to sanitize
 * @param stageId - The ID of the stage containing these questions
 * @returns A new array with invalid conditions cleared
 */
export function sanitizeSurveyQuestionConditions<
  T extends {id: string; condition?: Condition; items?: {id: string}[]},
>(questions: T[], stageId: string): T[] {
  // Build a map of question ID to its index in the ordering
  const questionIndexMap = new Map<string, number>();
  const questionItemIds = new Map<string, Set<string>>();
  questions.forEach((q, idx) => {
    questionIndexMap.set(q.id, idx);
    questionItemIds.set(q.id, new Set((q.items ?? []).map((item) => item.id)));
  });

  return questions.map((question, index) => {
    if (!question.condition) return question;

    const dependencies = extractConditionDependencies(question.condition);

    // Check if any dependency in the same stage is invalid
    const hasInvalidDependency = dependencies.some((dep) => {
      if (dep.stageId !== stageId) return false; // Other stages are fine

      const refIndex = questionIndexMap.get(dep.questionId);
      // Invalid if: question doesn't exist, or comes at/after current position
      if (refIndex === undefined || refIndex >= index) {
        return true;
      }
      // Also invalid if it points at an item the question no longer has
      if (dep.itemId) {
        return !questionItemIds.get(dep.questionId)?.has(dep.itemId);
      }
      return false;
    });

    if (hasInvalidDependency) {
      return {...question, condition: undefined};
    }
    return question;
  });
}
