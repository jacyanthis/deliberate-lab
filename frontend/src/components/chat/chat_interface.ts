import '../chat/chat_info_panel';
import '../chat/chat_input';
import '../chat/chat_message';

import {MobxLitElement} from '@adobe/lit-mobx';
import {computed} from 'mobx';
import {CSSResultGroup, html, nothing} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';

import {
  ChatStageConfig,
  ChatStagePublicData,
  StageConfig,
  StageKind,
} from '@deliberation-lab/utils';
import {core} from '../../core/core';
import {AuthService} from '../../services/auth.service';
import {CohortService} from '../../services/cohort.service';
import {ParticipantService} from '../../services/participant.service';

import {styles} from './chat_interface.scss';
import {getHashBasedColor, getProfileBasedColor} from '../../shared/utils';

/** Chat interface component */
@customElement('chat-interface')
export class ChatInterface extends MobxLitElement {
  static override styles: CSSResultGroup = [styles];

  private readonly cohortService = core.getService(CohortService);
  private readonly participantService = core.getService(ParticipantService);
  private readonly authService = core.getService(AuthService);

  @property({type: Object}) stage: StageConfig | undefined = undefined;
  @property({type: Boolean}) showPanel = false;
  @property({type: Boolean}) showInput = true;
  @property({type: Boolean}) disableInput = false;

  // Tracks inner width of window
  @state() mobileView = false;

  // "Setting up the group chat..." banner shown while agent participants /
  // personas are still being generated (before the first turn or message),
  // held for at least 1 second once it appears. While it shows it takes the
  // place of the turn banner and suppresses the typing dots.
  @state() private sawSetup = false;
  @state() private minSetupTimePassed = false;
  private setupTimer: number | undefined;

  private updateResponsiveState = () => {
    this.mobileView = window.innerWidth <= 1024;
  };

  connectedCallback() {
    super.connectedCallback();
    this.updateResponsiveState();
    window.addEventListener('resize', this.updateResponsiveState);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('resize', this.updateResponsiveState);
    if (this.setupTimer !== undefined) {
      clearTimeout(this.setupTimer);
      this.setupTimer = undefined;
    }
  }

  override updated() {
    // Once the chat data has loaded but the chat isn't ready yet (agents /
    // personas still generating), start the minimum-display timer so the
    // banner stays up for at least 1s even if setup finishes sooner.
    if (
      !this.sawSetup &&
      this.isTurnBasedGroupChat &&
      !this.cohortService.isChatLoading &&
      !this.isChatReady
    ) {
      this.sawSetup = true;
      this.setupTimer = window.setTimeout(() => {
        this.minSetupTimePassed = true;
      }, 1000);
    }
  }

  private get isGroupChat(): boolean {
    return this.stage?.kind === StageKind.CHAT;
  }

  /** Whether this is a turn-based group chat.
   *
   * The banner area only exists in a turn-based chat, which is the one that
   * shows whose turn it is. A chat that is not turn-based shows no banner at
   * all, so the setup banner does not belong there either: it would be the
   * only banner that stage ever had, and with no turn to assign it would stay
   * up until somebody sent the first message.
   */
  private get isTurnBasedGroupChat(): boolean {
    if (!this.isGroupChat) return false;
    return Boolean((this.stage as ChatStageConfig).isTurnBased);
  }

  /** Whether the group chat has started: a turn is assigned or a message
   *  exists. Before this, agent participants/personas may still be generating. */
  private get isChatReady(): boolean {
    const stageId = this.stage?.id ?? '';
    if (!stageId) return false;
    const data = this.cohortService.stagePublicDataMap[stageId] as
      | ChatStagePublicData
      | undefined;
    if (data?.currentTurnParticipantId) return true;
    if ((this.cohortService.chatMap[stageId] ?? []).length > 0) return true;
    const discussionMap = this.cohortService.chatDiscussionMap[stageId];
    return Boolean(
      discussionMap &&
      Object.values(discussionMap).some((messages) => messages.length > 0),
    );
  }

  /** Show the yellow setup banner while a group chat is being set up, holding
   *  it for at least 1s once it appears. While shown it replaces the turn
   *  banner and the typing dots are suppressed. */
  private get showSetupBanner(): boolean {
    if (!this.isTurnBasedGroupChat) return false;
    if (this.cohortService.isChatLoading) return false;
    if (!this.isChatReady) return true;
    return this.sawSetup && !this.minSetupTimePassed;
  }

  private renderPanel() {
    if (!this.stage) return nothing;
    return html`
      <chat-info-panel .stage=${this.stage} .topLayout=${this.mobileView}>
      </chat-info-panel>
    `;
  }

  @computed get stagePublicData() {
    if (!this.stage || this.stage.kind !== StageKind.CHAT) return null;
    return this.cohortService.stagePublicDataMap[this.stage.id] as
      | ChatStagePublicData
      | undefined;
  }

  @computed get isMyTurn() {
    if (!this.stage || this.stage.kind !== StageKind.CHAT) return true;
    const config = this.stage as ChatStageConfig;
    if (!config.isTurnBased) return true;

    return this.turnIndicatorState?.isMyTurn ?? false;
  }

  @computed get turnIndicatorState() {
    if (!this.stage || this.stage.kind !== StageKind.CHAT) return null;
    const config = this.stage as ChatStageConfig;
    if (!config.isTurnBased) return null;

    const data = this.stagePublicData;
    if (!data || !data.currentTurnParticipantId) return null;

    const id = data.currentTurnParticipantId;

    // If the latest message is already from the current turn holder, the
    // backend trigger hasn't advanced the turn yet — hide the indicator to
    // avoid a stale "Waiting for X" flash immediately after X just spoke.
    const messages = this.cohortService.chatMap[this.stage.id] ?? [];
    const latest = messages[messages.length - 1];
    if (latest?.senderId === id) return null;

    const isMyTurn =
      !this.participantService.profile?.agentConfig &&
      id === this.participantService.profile?.publicId;

    const participantProfile =
      this.cohortService.participantMap[data.currentTurnParticipantId];
    if (participantProfile && participantProfile.name) {
      return {
        name: participantProfile.name,
        avatar: participantProfile.avatar,
        isMediator: false,
        id,
        isMyTurn,
      };
    }

    const mediatorProfile =
      this.cohortService.mediatorMap[data.currentTurnParticipantId];
    if (mediatorProfile && mediatorProfile.name) {
      return {
        name: mediatorProfile.name,
        avatar: mediatorProfile.avatar ?? '🤖',
        isMediator: true,
        id,
        isMyTurn,
      };
    }

    return {
      name: id,
      avatar: '👤',
      isMediator: false,
      id,
      isMyTurn,
    };
  }

  private renderTypingIndicator() {
    // While the setup banner is showing, suppress the typing dots even if a
    // turn has just been assigned.
    if (this.showSetupBanner) return nothing;
    const turnState = this.turnIndicatorState;
    if (!turnState) return nothing;

    // Do not show typing indicator if it is the current user's turn (they type in the textarea instead!)
    if (turnState.isMyTurn) return nothing;

    const color = turnState.isMediator
      ? getHashBasedColor(turnState.id)
      : getProfileBasedColor(turnState.id, turnState.avatar ?? '');

    return html`
      <div class="chat-message typing-msg">
        <avatar-icon .emoji=${turnState.avatar} .color=${color}> </avatar-icon>
        <div class="content">
          <div class="label">${turnState.name}</div>
          <div class="chat-bubble typing-bubble">
            <div class="typing-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  override render() {
    if (!this.stage) return nothing;
    return html`
      <div class="interface-wrapper ${this.mobileView ? 'vertical' : ''}">
        ${this.showPanel ? this.renderPanel() : nothing}
        <div class="main-content">
          <div class="chat-content">
            ${this.renderTurnBanner()}
            <div class="chat-scroll">
              <div class="chat-history">
                ${this.mobileView
                  ? html`<slot name="mobile-description"></slot>`
                  : nothing}
                <slot></slot>
                ${this.renderTypingIndicator()}
              </div>
            </div>
          </div>
          <slot name="indicators"></slot>
          ${!this.showInput
            ? nothing
            : html`<chat-input
                .stageId=${this.stage?.id ?? ''}
                .isDisabled=${this.disableInput || !this.isMyTurn}
              ></chat-input>`}
        </div>
      </div>
    `;
  }

  private renderTurnBanner() {
    // The setup banner occupies the same slot as the turn banner and takes
    // precedence: while it shows, the "Waiting for ..." banner does not.
    if (this.showSetupBanner) {
      return html`
        <div class="banner warning setup-banner">
          <span class="setup-spinner" aria-hidden="true"></span>
          <span>Setting up the group chat...</span>
        </div>
      `;
    }

    const turnState = this.turnIndicatorState;
    if (!turnState) return nothing;

    if (turnState.isMyTurn) {
      return html` <div class="banner success">It's your turn to speak!</div> `;
    }

    return html`
      <div class="banner warning">
        Waiting for <strong>${turnState.name}</strong> to speak...
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-interface': ChatInterface;
  }
}
