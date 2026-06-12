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
  PrivateChatStageConfig,
  StageConfig,
  StageKind,
  UserType,
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
    if (!this.stage) return true;
    if (this.stage.kind === StageKind.PRIVATE_CHAT) {
      const config = this.stage as PrivateChatStageConfig;
      if (!config.isTurnBasedChatGroupStyle) return true;
      return this.turnIndicatorState?.isMyTurn ?? false;
    }
    if (this.stage.kind !== StageKind.CHAT) return true;
    const config = this.stage as ChatStageConfig;
    if (!config.isTurnBased) return true;

    return this.turnIndicatorState?.isMyTurn ?? false;
  }

  @computed get turnIndicatorState() {
    if (!this.stage) return null;
    if (this.stage.kind === StageKind.PRIVATE_CHAT) {
      return this.privateChatTurnIndicatorState;
    }
    if (this.stage.kind !== StageKind.CHAT) return null;
    const config = this.stage as ChatStageConfig;
    if (!config.isTurnBased) return null;

    const data = this.stagePublicData;
    if (!data || !data.currentTurnParticipantId) return null;

    let id = data.currentTurnParticipantId;

    // If the latest message is already from the current turn holder, the
    // backend trigger hasn't advanced the turn yet. To avoid the banner
    // disappearing momentarily (which jumps the chat layout above), predict
    // the next turn holder from turnOrder so the indicator swaps content in
    // place. End-of-cycle wraps may reshuffle, so only predict within the
    // current cycle; at the wrap point we fall through and the caller's
    // placeholder keeps the banner element present.
    const messages = this.cohortService.chatMap[this.stage.id] ?? [];
    const latest = messages[messages.length - 1];
    if (
      latest?.senderId === id &&
      data.turnOrder &&
      data.turnOrder.length > 1
    ) {
      const currentIdx = data.turnOrder.indexOf(id);
      if (currentIdx !== -1 && currentIdx < data.turnOrder.length - 1) {
        id = data.turnOrder[currentIdx + 1];
      } else {
        return null;
      }
    }

    return this.buildGroupChatTurnState(id);
  }

  private buildGroupChatTurnState(id: string) {
    const isMyTurn =
      !this.participantService.profile?.agentConfig &&
      id === this.participantService.profile?.publicId;

    const participantProfile = this.cohortService.participantMap[id];
    if (participantProfile && participantProfile.name) {
      return {
        name: participantProfile.name,
        avatar: participantProfile.avatar,
        isMediator: false,
        id,
        isMyTurn,
      };
    }

    const mediatorProfile = this.cohortService.mediatorMap[id];
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

  /** Whether the current stage is configured for turn-based interaction.
   * When true, the banner element is kept in the DOM across turn transitions
   * (even if the turn indicator state is momentarily null) so the chat
   * content above does not shift up or down between turns.
   */
  @computed get isTurnBasedMode() {
    if (!this.stage) return false;
    if (this.stage.kind === StageKind.PRIVATE_CHAT) {
      return (
        (this.stage as PrivateChatStageConfig).isTurnBasedChatGroupStyle ??
        false
      );
    }
    if (this.stage.kind === StageKind.CHAT) {
      return (this.stage as ChatStageConfig).isTurnBased ?? false;
    }
    return false;
  }

  @computed private get privateChatTurnIndicatorState() {
    if (!this.stage || this.stage.kind !== StageKind.PRIVATE_CHAT) return null;
    const config = this.stage as PrivateChatStageConfig;
    if (!config.isTurnBasedChatGroupStyle) return null;

    // Turn alternates between the participant and the mediator, with the
    // mediator always going first. Errors from the mediator count as their
    // turn so the participant is unblocked to retry.
    const messages =
      this.participantService.privateChatMap[this.stage.id] ?? [];
    const publicId = this.participantService.profile?.publicId ?? '';
    const latest = messages[messages.length - 1];
    const isMyTurn = !!latest && latest.senderId !== publicId;

    if (isMyTurn) {
      const profile = this.participantService.profile;
      return {
        name: profile?.name ?? '',
        avatar: profile?.avatar ?? '',
        isMediator: false,
        id: publicId,
        isMyTurn: true,
      };
    }

    const lastMediatorMsg = [...messages]
      .reverse()
      .find((m) => m.type === UserType.MEDIATOR);
    const assignedMediator = this.cohortService.getMediatorsForStage(
      this.stage.id,
    )[0];

    return {
      name:
        lastMediatorMsg?.profile?.name ?? assignedMediator?.name ?? 'Mediator',
      avatar:
        lastMediatorMsg?.profile?.avatar ?? assignedMediator?.avatar ?? '🤖',
      isMediator: true,
      id: lastMediatorMsg?.senderId ?? assignedMediator?.publicId ?? 'mediator',
      isMyTurn: false,
    };
  }

  private renderTypingIndicator() {
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
    const turnState = this.turnIndicatorState;
    if (!turnState) {
      // Keep an empty banner element in the DOM during transient turn-
      // transitions (e.g., end-of-cycle wraps) so the chat content above
      // does not shift up or down. The placeholder banner reserves the
      // same vertical space as a real banner but renders no visible text.
      if (this.isTurnBasedMode) {
        return html`<div class="banner banner-placeholder">&nbsp;</div>`;
      }
      return nothing;
    }

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
