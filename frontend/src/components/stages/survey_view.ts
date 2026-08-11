import '../../pair-components/textarea';

import '../progress/progress_stage_completed';
import './stage_description';
import './stage_footer';

import '@material/web/radio/radio.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/slider/slider.js';
import '@material/web/textfield/outlined-text-field.js';

import {MobxLitElement} from '@adobe/lit-mobx';
import {CSSResultGroup, html, nothing} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';

import {
  AllocationItem,
  AllocationSurveyAnswer,
  AllocationSurveyQuestion,
  CheckItem,
  CheckSurveyAnswer,
  CheckSurveyQuestion,
  MultipleChoiceDisplayType,
  MultipleChoiceItem,
  MultipleChoiceSurveyAnswer,
  MultipleChoiceSurveyQuestion,
  SurveyQuestion,
  ScaleSurveyAnswer,
  ScaleSurveyQuestion,
  SurveyQuestionKind,
  SurveyStageConfig,
  TextSurveyAnswer,
  TextSurveyQuestion,
  formatAllocationValue,
  getAllocationTotal,
  getCheckedItemIds,
  getRemainingCheckSelections,
  isMultipleChoiceImageQuestion,
  getSurveyQuestionDisplayOrder,
  getVisibleSurveyQuestions,
  isQuestionVisible,
  isSurveyComplete,
  isSurveyAnswerComplete,
} from '@deliberation-lab/utils';

import {unsafeHTML} from 'lit/directives/unsafe-html.js';
import {
  convertMarkdownToHTML,
  pinAllocationSliderLabels,
} from '../../shared/utils';
import {core} from '../../core/core';
import {ParticipantService} from '../../services/participant.service';
import {ParticipantAnswerService} from '../../services/participant.answer';

import {styles} from './survey_view.scss';

/** Survey stage view for participants */
@customElement('survey-view')
export class SurveyView extends MobxLitElement {
  static override styles: CSSResultGroup = [styles];

  private readonly participantService = core.getService(ParticipantService);
  private readonly participantAnswerService = core.getService(
    ParticipantAnswerService,
  );

  @property() stage: SurveyStageConfig | undefined = undefined;

  override updated() {
    // An allocation slider shows its amount at all times
    pinAllocationSliderLabels(this.renderRoot);
  }

  override render() {
    if (!this.stage) {
      return nothing;
    }

    const questionsComplete = (): boolean => {
      if (!this.stage) return false;

      const currentSurveyAnswers =
        this.participantAnswerService.getSurveyAnswerMap(this.stage.id);
      const allStageAnswers = this.participantAnswerService.answerMap;
      const visibleQuestions = getVisibleSurveyQuestions(
        this.stage.questions,
        this.stage.id,
        currentSurveyAnswers,
        allStageAnswers,
        undefined,
        this.participantService.profile?.variableMap,
      );

      return isSurveyComplete(visibleQuestions, currentSurveyAnswers);
    };

    const saveAnswers = async () => {
      if (!this.stage) return;

      // Save all answers for this stage. Advancing without the save would
      // lose the answers for good, so a save that did not happen keeps the
      // participant on the page to try again.
      const saved = await this.participantAnswerService.saveSurveyAnswers(
        this.stage.id,
      );
      if (!saved) return;
      await this.participantService.progressToNextStage();
    };

    return html`
      <stage-description .stage=${this.stage}></stage-description>
      <div class="questions-wrapper">
        ${this.stage.questions.map((question) => {
          if (this.shouldShowQuestion(question)) {
            return this.renderQuestion(question);
          }
          return nothing;
        })}
      </div>
      <stage-footer
        .disabled=${!questionsComplete()}
        .onNextClick=${saveAnswers}
      >
        ${this.stage.progress.showParticipantProgress
          ? html`<progress-stage-completed></progress-stage-completed>`
          : nothing}
      </stage-footer>
    `;
  }

  private shouldShowQuestion(question: SurveyQuestion): boolean {
    if (!this.stage) return true;

    const currentSurveyAnswers =
      this.participantAnswerService.getSurveyAnswerMap(this.stage.id);
    const allStageAnswers = this.participantAnswerService.answerMap;

    return isQuestionVisible(
      question,
      this.stage.id,
      currentSurveyAnswers,
      allStageAnswers,
      undefined,
      this.participantService.profile?.variableMap,
    );
  }

  private renderQuestion(question: SurveyQuestion) {
    switch (question.kind) {
      case SurveyQuestionKind.CHECK:
        return this.renderCheckQuestion(question);
      case SurveyQuestionKind.MULTIPLE_CHOICE:
        return this.renderMultipleChoiceQuestion(question);
      case SurveyQuestionKind.SCALE:
        return this.renderScaleQuestion(question);
      case SurveyQuestionKind.TEXT:
        return this.renderTextQuestion(question);
      case SurveyQuestionKind.ALLOCATION:
        return this.renderAllocationQuestion(question);
      default:
        return nothing;
    }
  }

  private renderCheckQuestion(question: CheckSurveyQuestion) {
    if (question.items?.length) {
      return this.renderCheckItemsQuestion(question);
    }
    const isChecked = () => {
      if (!this.stage) return;
      const answer = this.participantAnswerService.getSurveyAnswer(
        this.stage.id,
        question.id,
      );
      if (answer && answer.kind === SurveyQuestionKind.CHECK) {
        return answer.isChecked;
      }
      return false;
    };

    const handleCheck = () => {
      const answer: CheckSurveyAnswer = {
        id: question.id,
        kind: SurveyQuestionKind.CHECK,
        isChecked: !isChecked(),
      };
      // Update stage answer
      if (!this.stage) return;
      this.participantAnswerService.updateSurveyAnswer(this.stage.id, answer);
    };

    const titleClasses = classMap({
      required: question.isRequired && !isChecked(),
    });

    return html`
      <div class="question">
        <label class="checkbox-wrapper">
          <md-checkbox
            touch-target="wrapper"
            aria-label=${question.questionTitle}
            ?checked=${isChecked()}
            ?disabled=${this.participantService.disableStage}
            @click=${handleCheck}
          >
          </md-checkbox>
          <div class=${titleClasses}>
            ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
          </div>
        </label>
      </div>
    `;
  }

  private renderCheckItemsQuestion(question: CheckSurveyQuestion) {
    const answer = this.getCheckAnswer(question);
    const checkedCount = getCheckedItemIds(question, answer).length;
    const titleClasses = classMap({
      required: question.isRequired && checkedCount === 0,
    });

    return html`
      <div class="question">
        <div class=${titleClasses}>
          ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
        </div>
        <div class="checkbox-items">
          ${this.displayOrder(question.items ?? [], question).map((item) =>
            this.renderCheckItem(question, item),
          )}
        </div>
      </div>
    `;
  }

  /** Items or options in the order this participant should see them. */
  private displayOrder<T>(
    items: readonly T[],
    question: {randomizeOrder?: boolean; randomizeOrderKey?: string},
  ): T[] {
    return getSurveyQuestionDisplayOrder(
      items,
      question,
      this.stage?.id ?? '',
      this.participantService.profile?.publicId ?? '',
    );
  }

  private renderCheckItem(question: CheckSurveyQuestion, item: CheckItem) {
    const answer = this.getCheckAnswer(question);
    const checkedMap = answer?.checkedMap ?? {};
    const isChecked = checkedMap[item.id] === true;
    const remaining = getRemainingCheckSelections(question, answer);
    const atLimit = remaining === 0 && !isChecked;

    const handleCheck = () => {
      if (!this.stage) return;
      const updatedMap = {...checkedMap, [item.id]: !isChecked};
      const checkAnswer: CheckSurveyAnswer = {
        id: question.id,
        kind: SurveyQuestionKind.CHECK,
        isChecked: Object.values(updatedMap).some((checked) => checked),
        checkedMap: updatedMap,
      };
      this.participantAnswerService.updateSurveyAnswer(
        this.stage.id,
        checkAnswer,
      );
    };

    return html`
      <label class="checkbox-wrapper">
        <md-checkbox
          touch-target="wrapper"
          aria-label=${item.text}
          ?checked=${isChecked}
          ?disabled=${this.participantService.disableStage || atLimit}
          @click=${handleCheck}
        >
        </md-checkbox>
        <div>${unsafeHTML(convertMarkdownToHTML(item.text))}</div>
      </label>
    `;
  }

  private getCheckAnswer(question: CheckSurveyQuestion) {
    if (!this.stage) return undefined;
    const answer = this.participantAnswerService.getSurveyAnswer(
      this.stage.id,
      question.id,
    );
    if (answer && answer.kind === SurveyQuestionKind.CHECK) {
      return answer;
    }
    return undefined;
  }

  private renderTextQuestion(question: TextSurveyQuestion) {
    if (!this.stage) return;

    const handleTextChange = (e: Event) => {
      if (!this.stage) return;
      const answer = (e.target as HTMLInputElement).value ?? '';
      const textAnswer: TextSurveyAnswer = {
        id: question.id,
        kind: SurveyQuestionKind.TEXT,
        answer,
      };
      this.participantAnswerService.updateSurveyAnswer(
        this.stage.id,
        textAnswer,
      );
    };

    const answer = this.participantAnswerService.getSurveyAnswer(
      this.stage.id,
      question.id,
    );
    const textAnswer =
      answer && answer.kind === SurveyQuestionKind.TEXT ? answer.answer : '';

    const titleClasses = classMap({
      required: !isSurveyAnswerComplete(answer, question),
    });

    // Check if current answer meets requirements for error state
    const minCount = question.minCharCount ?? null;
    const maxCount = question.maxCharCount ?? null;

    const isTooShort = minCount !== null && textAnswer.length < minCount;

    // Build error text (only needed for minimum since maxlength prevents exceeding max)
    const errorText = isTooShort
      ? `Minimum ${minCount} characters required`
      : '';

    return html`
      <div class="question">
        <div class=${titleClasses}>
          ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
        </div>
        <md-outlined-text-field
          type="textarea"
          placeholder="Type your response"
          .value=${textAnswer}
          ?disabled=${this.participantService.disableStage}
          @input=${handleTextChange}
          .minLength=${minCount ?? nothing}
          .maxLength=${maxCount ?? nothing}
          .error=${isTooShort}
          .errorText=${errorText}
          .counter=${maxCount !== null}
        >
        </md-outlined-text-field>
      </div>
    `;
  }

  private renderMultipleChoiceQuestion(question: MultipleChoiceSurveyQuestion) {
    const titleClasses = classMap({
      required: !isSurveyAnswerComplete(
        this.participantAnswerService.getSurveyAnswer(
          this.stage?.id ?? '',
          question.id,
        ),
      ),
    });

    if (
      question.displayType === MultipleChoiceDisplayType.DROPDOWN &&
      !isMultipleChoiceImageQuestion(question)
    ) {
      return this.renderDropdownQuestion(question, titleClasses);
    }

    const questionWrapperClasses = classMap({
      'radio-question-wrapper': true,
      image: isMultipleChoiceImageQuestion(question),
    });

    return html`
      <div class="radio-question">
        <div class=${titleClasses}>
          ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
        </div>
        <div class=${questionWrapperClasses}>
          ${this.displayOrder(question.options, question).map((option) =>
            this.renderRadioButton(option, question.id),
          )}
        </div>
      </div>
    `;
  }

  private renderDropdownQuestion(
    question: MultipleChoiceSurveyQuestion,
    titleClasses: ReturnType<typeof classMap>,
  ) {
    const selectedChoiceId = (() => {
      if (!this.stage) return '';
      const answer = this.participantAnswerService.getSurveyAnswer(
        this.stage.id,
        question.id,
      );
      if (answer && answer.kind === SurveyQuestionKind.MULTIPLE_CHOICE) {
        return answer.choiceId;
      }
      return '';
    })();

    const handleChange = (e: Event) => {
      const value = (e.target as HTMLSelectElement).value;
      if (!value || !this.stage) return;
      const answer: MultipleChoiceSurveyAnswer = {
        id: question.id,
        kind: SurveyQuestionKind.MULTIPLE_CHOICE,
        choiceId: value,
      };
      this.participantAnswerService.updateSurveyAnswer(this.stage.id, answer);
    };

    return html`
      <div class="radio-question">
        <div class=${titleClasses}>
          ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
        </div>
        <md-outlined-select
          class="dropdown-select"
          label="Select an option"
          ?disabled=${this.participantService.disableStage}
          @change=${handleChange}
        >
          ${this.displayOrder(question.options, question).map(
            (option) => html`
              <md-select-option
                value=${option.id}
                ?selected=${selectedChoiceId === option.id}
              >
                <div slot="headline">
                  ${unsafeHTML(convertMarkdownToHTML(option.text))}
                </div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
      </div>
    `;
  }

  private isMultipleChoiceMatch(questionId: string, choiceId: string) {
    if (!this.stage) return;
    const answer = this.participantAnswerService.getSurveyAnswer(
      this.stage.id,
      questionId,
    );
    if (answer && answer.kind === SurveyQuestionKind.MULTIPLE_CHOICE) {
      return answer?.choiceId === choiceId;
    }
    return false;
  }

  private renderRadioButton(choice: MultipleChoiceItem, questionId: string) {
    const id = `${questionId}-${choice.id}`;

    const handleMultipleChoiceClick = (e: Event) => {
      const answer: MultipleChoiceSurveyAnswer = {
        id: questionId,
        kind: SurveyQuestionKind.MULTIPLE_CHOICE,
        choiceId: choice.id,
      };
      // Update stage answer
      if (!this.stage) return;
      this.participantAnswerService.updateSurveyAnswer(this.stage.id, answer);
    };

    if (choice.imageId.length > 0) {
      const classes = classMap({
        'image-question': true,
        selected: this.isMultipleChoiceMatch(questionId, choice.id) ?? false,
        disabled: this.participantService.disableStage,
      });

      return html`
        <div class=${classes} @click=${handleMultipleChoiceClick}>
          <div class="img-wrapper">
            <img src=${choice.imageId} />
          </div>
          <div class="radio-button">
            <md-radio
              id=${id}
              name=${questionId}
              value=${choice.id}
              aria-label=${choice.text}
              ?checked=${this.isMultipleChoiceMatch(questionId, choice.id)}
              ?disabled=${this.participantService.disableStage}
            >
            </md-radio>
            <label for=${id}
              >${unsafeHTML(convertMarkdownToHTML(choice.text))}</label
            >
          </div>
        </div>
      `;
    }

    return html`
      <div class="radio-button">
        <md-radio
          id=${id}
          name=${questionId}
          value=${choice.id}
          aria-label=${choice.text}
          ?checked=${this.isMultipleChoiceMatch(questionId, choice.id)}
          ?disabled=${this.participantService.disableStage}
          @change=${handleMultipleChoiceClick}
        >
        </md-radio>
        <label for=${id}
          >${unsafeHTML(convertMarkdownToHTML(choice.text))}</label
        >
      </div>
    `;
  }

  private renderScaleQuestion(question: ScaleSurveyQuestion) {
    const stepSize = question.stepSize ?? 1;
    const scale = [];
    for (let i = question.lowerValue; i <= question.upperValue; i += stepSize) {
      scale.push(i);
    }

    const titleClasses = classMap({
      required: !isSurveyAnswerComplete(
        this.participantAnswerService.getSurveyAnswer(
          this.stage?.id ?? '',
          question.id,
        ),
      ),
    });

    if (question.useSlider) {
      return this.renderScaleSlider(question);
    }

    return html`
      <div class="question">
        <div class=${titleClasses}>
          ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
        </div>
        <div class="scale labels">
          <div>${question.lowerText}</div>
          <div>${question.middleText}</div>
          <div>${question.upperText}</div>
        </div>
        <div class="scale values">
          ${scale.map((num) => this.renderScaleRadioButton(question, num))}
        </div>
      </div>
    `;
  }

  private renderScaleSlider(question: ScaleSurveyQuestion) {
    const titleClasses = classMap({
      required: !isSurveyAnswerComplete(
        this.participantAnswerService.getSurveyAnswer(
          this.stage?.id ?? '',
          question.id,
        ),
      ),
    });
    const getCurrentValue = () => {
      if (!this.stage) return question.lowerValue;
      const answer = this.participantAnswerService.getSurveyAnswer(
        this.stage.id,
        question.id,
      );
      if (answer && answer.kind === SurveyQuestionKind.SCALE) {
        return answer.value;
      }
      return question.lowerValue;
    };

    const handleSliderChange = (e: Event) => {
      const value = Number((e.target as HTMLInputElement).value);
      const answer: ScaleSurveyAnswer = {
        id: question.id,
        kind: SurveyQuestionKind.SCALE,
        value,
      };

      // Update stage answer
      if (!this.stage) return;
      this.participantAnswerService.updateSurveyAnswer(this.stage.id, answer);
    };

    return html`
      <div class="question">
        <div class=${titleClasses}>
          ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
        </div>
        <div class="scale slider-row">
          <div class="slider-value">${question.lowerValue}</div>
          <md-slider
            min=${question.lowerValue}
            max=${question.upperValue}
            step=${question.stepSize ?? 1}
            value=${getCurrentValue()}
            ticks
            labeled
            ?disabled=${this.participantService.disableStage}
            @input=${handleSliderChange}
          >
          </md-slider>
          <div class="slider-value">${question.upperValue}</div>
        </div>
        <div class="scale labels">
          <div>${question.lowerText}</div>
          <div>${question.middleText}</div>
          <div>${question.upperText}</div>
        </div>
      </div>
    `;
  }

  private renderAllocationQuestion(question: AllocationSurveyQuestion) {
    const answer = this.getAllocationAnswer(question);
    const allocated = getAllocationTotal(question, answer);
    const isExact = allocated === question.totalValue;

    const titleClasses = classMap({required: !isExact});

    return html`
      <div class="question">
        <div class=${titleClasses}>
          ${unsafeHTML(convertMarkdownToHTML(question.questionTitle + '*'))}
        </div>
        ${this.displayOrder(question.items, question).map((item) =>
          this.renderAllocationItem(question, item, allocated),
        )}
        ${isExact
          ? html`<div class="allocation-total">
              The current total is
              ${formatAllocationValue(question.totalValue, question.unitText)}.
              You can reduce the amount in one slider to increase it in another.
            </div>`
          : html`<div class="allocation-total required">
              The current total is
              ${formatAllocationValue(allocated, question.unitText)}. Please
              distribute
              ${formatAllocationValue(question.totalValue, question.unitText)}
              to continue.
            </div>`}
      </div>
    `;
  }

  private renderAllocationItem(
    question: AllocationSurveyQuestion,
    item: AllocationItem,
    allocated: number,
  ) {
    const answer = this.getAllocationAnswer(question);
    const value = answer?.allocationMap[item.id] ?? 0;
    const stepSize = question.stepSize ?? 1;
    // The amount this item can hold before the question runs out of budget
    const cap = value + (question.totalValue - allocated);

    const handleSliderChange = (e: Event) => {
      if (!this.stage) return;
      const slider = e.target as HTMLInputElement;
      const capped = Math.min(Number(slider.value), cap);
      if (capped !== Number(slider.value)) {
        // Keep the slider in step with the stored value when it hits the cap
        slider.value = capped.toString();
      }
      const allocationAnswer: AllocationSurveyAnswer = {
        id: question.id,
        kind: SurveyQuestionKind.ALLOCATION,
        allocationMap: {...(answer?.allocationMap ?? {}), [item.id]: capped},
      };
      this.participantAnswerService.updateSurveyAnswer(
        this.stage.id,
        allocationAnswer,
      );
    };

    const id = `${question.id}-${item.id}`;

    return html`
      <div class="allocation-item">
        <label class="allocation-item-text" for=${id}>
          ${unsafeHTML(convertMarkdownToHTML(item.text))}
        </label>
        <md-slider
          id=${id}
          min="0"
          max=${question.totalValue}
          step=${stepSize}
          value=${value}
          value-label=${formatAllocationValue(value, question.unitText)}
          ticks
          labeled
          ?disabled=${this.participantService.disableStage}
          @input=${handleSliderChange}
        >
        </md-slider>
      </div>
    `;
  }

  private getAllocationAnswer(question: AllocationSurveyQuestion) {
    if (!this.stage) return undefined;
    const answer = this.participantAnswerService.getSurveyAnswer(
      this.stage.id,
      question.id,
    );
    if (answer && answer.kind === SurveyQuestionKind.ALLOCATION) {
      return answer;
    }
    return undefined;
  }

  private renderScaleRadioButton(question: ScaleSurveyQuestion, value: number) {
    const name = `${question.id}`;
    const id = `${question.id}-${value}`;

    const isScaleChoiceMatch = (value: number) => {
      if (!this.stage) return;
      const answer = this.participantAnswerService.getSurveyAnswer(
        this.stage.id,
        question.id,
      );
      if (answer && answer.kind === SurveyQuestionKind.SCALE) {
        return answer.value === value;
      }
      return false;
    };

    const handleScaleClick = (e: Event) => {
      const value = Number((e.target as HTMLInputElement).value);
      const answer: ScaleSurveyAnswer = {
        id: question.id,
        kind: SurveyQuestionKind.SCALE,
        value,
      };

      // Update stage answer
      if (!this.stage) return;
      this.participantAnswerService.updateSurveyAnswer(this.stage.id, answer);
    };

    return html`
      <div class="scale-button">
        <md-radio
          id=${id}
          name=${name}
          value=${value}
          ?checked=${isScaleChoiceMatch(value)}
          ?disabled=${this.participantService.disableStage}
          @change=${handleScaleClick}
        >
        </md-radio>
        <label for=${id}>${value}</label>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'survey-view': SurveyView;
  }
}
