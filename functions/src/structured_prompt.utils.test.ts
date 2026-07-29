import {
  UserType,
  ParticipantProfileExtended,
  MediatorProfileExtended,
  BasePromptConfig,
  PromptItemType,
  StageKind,
  ComparisonOperator,
  ComparisonCondition,
  SYSTEM_VARIABLE_NAMESPACE,
} from '@deliberation-lab/utils';
import {
  getFirestoreDataForStructuredPrompt,
  getPromptFromConfig,
  shouldIncludePromptItem,
} from './structured_prompt.utils';
import * as firestoreUtils from './utils/firestore';

// Mock firestore utilities
jest.mock('./utils/firestore');
jest.mock('./app', () => {
  // Delegate getStageDisplayForPrompt to the real stage handlers so the merge
  // tests exercise the genuine "Private chat with NAME (id)" and survey-answer
  // formatting.
  const utils = jest.requireActual('@deliberation-lab/utils');
  const privateChatHandler = new utils.PrivateChatStageHandler();
  const surveyHandler = new utils.SurveyStageHandler();
  return {
    stageManager: {
      resolveTemplateVariablesInStage: jest.fn((stage) => stage),
      getStageDisplayForPrompt: jest.fn(
        (stage, participants, stageContext, includeScaffolding) =>
          (stage.kind === 'survey'
            ? surveyHandler
            : privateChatHandler
          ).getStageDisplayForPrompt(
            participants,
            stageContext,
            includeScaffolding,
          ),
      ),
    },
  };
});

describe('structured_prompt.utils', () => {
  describe('getFirestoreDataForStructuredPrompt', () => {
    const mockExperimentId = 'test-experiment';
    const mockCohortId = 'test-cohort';
    const mockStageId = 'test-stage';

    const mockParticipant: ParticipantProfileExtended = {
      id: 'participant-1',
      privateId: 'participant-private-1',
      publicId: 'participant-public-1',
      type: UserType.PARTICIPANT,
      name: 'Test Participant',
      avatar: '🐶',
      pronouns: 'they/them',
      currentCohortId: mockCohortId,
      currentExperimentId: mockExperimentId,
      currentStageId: mockStageId,
      timestamps: {
        accountCreated: {seconds: 0, nanoseconds: 0},
        lastLogin: {seconds: 0, nanoseconds: 0},
      },
      agentConfig: null,
      prolificId: null,
      transferCohortId: null,
      variableMap: {},
    };

    const mockParticipant2: ParticipantProfileExtended = {
      ...mockParticipant,
      id: 'participant-2',
      privateId: 'participant-private-2',
      publicId: 'participant-public-2',
      name: 'Test Participant 2',
      avatar: '🐱',
    };

    const mockMediator: MediatorProfileExtended = {
      id: 'mediator-1',
      privateId: 'mediator-private-1',
      publicId: 'mediator-public-1',
      type: UserType.MEDIATOR,
      name: 'Test Mediator',
      avatar: '🤖',
      pronouns: 'they/them',
      currentCohortId: mockCohortId,
      currentExperimentId: mockExperimentId,
      currentStageId: mockStageId,
      timestamps: {
        accountCreated: {seconds: 0, nanoseconds: 0},
        lastLogin: {seconds: 0, nanoseconds: 0},
      },
      agentConfig: {
        agentId: 'test-agent',
        model: 'test-model',
        apiKey: 'test-key',
        promptContext: 'test context',
      },
      prolificId: null,
      transferCohortId: null,
      variableMap: {},
    };

    const mockExperiment = {
      id: mockExperimentId,
      versionId: 'v1',
      metadata: {
        name: 'Test Experiment',
        publicName: 'Test',
        description: '',
        tags: [],
        date: {seconds: 0, nanoseconds: 0},
      },
      permissions: {experimenters: [], viewers: []},
      stageIds: [mockStageId],
      prolific: {
        enableProlificIntegration: false,
        defaultRedirectCode: null,
        completionCodeMap: {},
      },
      attentionCheckConfig: {
        numFailed: 0,
      },
      variableMap: {},
      variableConfigs: [],
    };

    const mockCohort = {
      id: mockCohortId,
      name: 'Test Cohort',
      metadata: {
        numberOfParticipants: 2,
        publicName: null,
        description: null,
        date: {seconds: 0, nanoseconds: 0},
      },
      participantConfig: {
        allowedParticipantIds: [],
        disabledParticipantIds: [],
      },
      variableMap: {},
    };

    const mockPromptConfig: BasePromptConfig = {
      prompt: [
        {
          type: PromptItemType.TEXT,
          text: 'Test prompt',
        },
      ],
    };

    beforeEach(() => {
      jest.clearAllMocks();

      // Setup default mocks
      (firestoreUtils.getFirestoreExperiment as jest.Mock).mockResolvedValue(
        mockExperiment,
      );
      (firestoreUtils.getFirestoreCohort as jest.Mock).mockResolvedValue(
        mockCohort,
      );
      (
        firestoreUtils.getFirestoreActiveParticipants as jest.Mock
      ).mockResolvedValue([mockParticipant, mockParticipant2]);
      (firestoreUtils.getFirestoreParticipant as jest.Mock).mockImplementation(
        async (experimentId: string, participantId: string) => {
          if (participantId === 'participant-private-1') return mockParticipant;
          if (participantId === 'participant-private-2')
            return mockParticipant2;
          return undefined;
        },
      );
    });

    it('should use contextParticipantIds when provided', async () => {
      const result = await getFirestoreDataForStructuredPrompt(
        mockExperimentId,
        mockCohortId,
        mockStageId,
        mockMediator,
        mockPromptConfig,
        ['participant-private-1'], // Only one participant
      );

      // Should fetch only the specified participant
      expect(result.participants).toHaveLength(1);
      expect(result.participants[0].privateId).toBe('participant-private-1');
      expect(firestoreUtils.getFirestoreParticipant).toHaveBeenCalledWith(
        mockExperimentId,
        'participant-private-1',
      );
    });

    it('should fetch multiple participants when multiple contextParticipantIds provided', async () => {
      const result = await getFirestoreDataForStructuredPrompt(
        mockExperimentId,
        mockCohortId,
        mockStageId,
        mockMediator,
        mockPromptConfig,
        ['participant-private-1', 'participant-private-2'],
      );

      // Should fetch both specified participants
      expect(result.participants).toHaveLength(2);
      expect(result.participants[0].privateId).toBe('participant-private-1');
      expect(result.participants[1].privateId).toBe('participant-private-2');
    });

    it('should use only participant own context when no contextParticipantIds and user is participant', async () => {
      const result = await getFirestoreDataForStructuredPrompt(
        mockExperimentId,
        mockCohortId,
        mockStageId,
        mockParticipant,
        mockPromptConfig,
        undefined, // No contextParticipantIds
      );

      // Should fetch only the participant's own data
      expect(result.participants).toHaveLength(1);
      expect(result.participants[0].privateId).toBe('participant-private-1');
      expect(firestoreUtils.getFirestoreParticipant).toHaveBeenCalledWith(
        mockExperimentId,
        'participant-private-1',
      );
    });

    it('should use all active participants when no contextParticipantIds and user is mediator', async () => {
      const result = await getFirestoreDataForStructuredPrompt(
        mockExperimentId,
        mockCohortId,
        mockStageId,
        mockMediator,
        mockPromptConfig,
        undefined, // No contextParticipantIds
      );

      // Should use all active participants
      expect(result.participants).toHaveLength(2);
      expect(result.participants[0].privateId).toBe('participant-private-1');
      expect(result.participants[1].privateId).toBe('participant-private-2');
    });

    it('should prioritize contextParticipantIds over user type logic', async () => {
      // Even though mediator would normally get all participants,
      // contextParticipantIds should override this
      const result = await getFirestoreDataForStructuredPrompt(
        mockExperimentId,
        mockCohortId,
        mockStageId,
        mockMediator,
        mockPromptConfig,
        ['participant-private-2'], // Only one specific participant
      );

      // Should only get the specified participant, not all participants
      expect(result.participants).toHaveLength(1);
      expect(result.participants[0].privateId).toBe('participant-private-2');
    });

    it('should handle empty contextParticipantIds array by falling back to default behavior', async () => {
      const result = await getFirestoreDataForStructuredPrompt(
        mockExperimentId,
        mockCohortId,
        mockStageId,
        mockMediator,
        mockPromptConfig,
        [], // Empty array
      );

      // Should fall back to default mediator behavior (all participants)
      expect(result.participants).toHaveLength(2);
    });

    it('re-adds the observer for a group-chat mediator when contextParticipantIds omits them', async () => {
      // The only human in the chat is an observer, and chat.triggers
      // builds contextParticipantIds from the non-observer turn-order list, so
      // only the persona agents are passed. The group-chat mediator must still
      // see the observer, so getFirestoreDataForStructuredPrompt re-adds
      // cohort observers (gated to MEDIATOR + group CHAT).
      const observer: ParticipantProfileExtended = {
        ...mockParticipant,
        privateId: 'human-priv',
        publicId: 'human-pub',
        name: 'Observer',
        isObserver: true,
      };
      const personaAgent: ParticipantProfileExtended = {
        ...mockParticipant,
        privateId: 'persona-priv-1',
        publicId: 'persona-pub-1',
        name: 'Persona Agent',
        agentConfig: {
          agentId: 'a',
          model: 'test-model',
          apiKey: 'test-key',
          promptContext: 'persona',
          isInactivePersona: true,
        },
      };
      (
        firestoreUtils.getFirestoreActiveParticipants as jest.Mock
      ).mockResolvedValue([observer, personaAgent]);
      (firestoreUtils.getFirestoreParticipant as jest.Mock).mockImplementation(
        async (_experimentId: string, participantId: string) => {
          if (participantId === 'persona-priv-1') return personaAgent;
          if (participantId === 'human-priv') return observer;
          return undefined;
        },
      );

      const result = await getFirestoreDataForStructuredPrompt(
        mockExperimentId,
        mockCohortId,
        mockStageId,
        mockMediator,
        {...mockPromptConfig, type: StageKind.CHAT},
        ['persona-priv-1'], // the observer is stripped upstream by chat.triggers
      );

      // The observer must be present so the mediator prompt includes their
      // answers alongside the persona agents.
      expect(result.participants.some((p) => p.publicId === 'human-pub')).toBe(
        true,
      );
      expect(
        result.participants.some((p) => p.publicId === 'persona-pub-1'),
      ).toBe(true);
    });
  });

  // Verifies a mediator sees every participant's private chat in one
  // STAGE_CONTEXT block (the human merged with inactive personas), rather
  // than the human split from the personas across separate prompt items.
  describe('getPromptFromConfig private-chat merge', () => {
    const experimentId = 'exp';
    const cohortId = 'cohort';
    const chatStageId = 'private-chat';

    const chatStage = {
      id: chatStageId,
      kind: StageKind.PRIVATE_CHAT,
      name: 'Private chat',
      descriptions: {primaryText: '', infoText: '', helpText: ''},
    };

    const experiment = {
      id: experimentId,
      stageIds: [chatStageId],
      variableConfigs: [],
      variableMap: {},
    };
    const cohort = {id: cohortId, variableMap: {}};

    const human: ParticipantProfileExtended = {
      id: 'h',
      privateId: 'h-priv',
      publicId: 'human-1',
      type: UserType.PARTICIPANT,
      name: 'Human',
      avatar: '🧑',
      pronouns: null,
      currentCohortId: cohortId,
      currentExperimentId: experimentId,
      currentStageId: chatStageId,
      timestamps: {
        accountCreated: {seconds: 0, nanoseconds: 0},
        lastLogin: {seconds: 0, nanoseconds: 0},
      },
      agentConfig: null,
      prolificId: null,
      transferCohortId: null,
      variableMap: {},
    } as unknown as ParticipantProfileExtended;

    const makePersonaAgent = (
      publicId: string,
      name: string,
      promptContext: string,
    ) =>
      ({
        ...human,
        id: publicId,
        privateId: `${publicId}-priv`,
        publicId,
        name,
        agentConfig: {
          agentId: publicId,
          promptContext,
          isInactivePersona: true,
        },
      }) as unknown as ParticipantProfileExtended;

    const persona1 = makePersonaAgent('agent-a', 'Avery', 'AVERY_CONTENT');
    const persona2 = makePersonaAgent('agent-b', 'Blair', 'BLAIR_CONTENT');

    const humanMessages = [
      {
        id: 'm0',
        discussionId: null,
        type: UserType.PARTICIPANT,
        message: 'HUMAN_ANSWER_TEXT',
        timestamp: {seconds: 100, nanoseconds: 0},
        profile: {name: 'Human', avatar: '🧑', pronouns: null},
        senderId: 'human',
      },
    ];

    const mediator = {
      id: 'mediator-1',
      privateId: 'mediator-1-priv',
      publicId: 'mediator-1',
      type: UserType.MEDIATOR,
      name: 'Riley',
      avatar: '🤖',
      pronouns: null,
      currentCohortId: cohortId,
      currentExperimentId: experimentId,
      currentStageId: chatStageId,
      timestamps: {
        accountCreated: {seconds: 0, nanoseconds: 0},
        lastLogin: {seconds: 0, nanoseconds: 0},
      },
      agentConfig: {agentId: 'mediator-1', promptContext: ''},
      prolificId: null,
      transferCohortId: null,
      variableMap: {},
    } as unknown as MediatorProfileExtended;

    const promptConfig: BasePromptConfig = {
      type: StageKind.PRIVATE_CHAT,
      includeScaffoldingInPrompt: false,
      prompt: [
        {
          type: PromptItemType.STAGE_CONTEXT,
          stageId: chatStageId,
          includeParticipantAnswers: true,
          includePrimaryText: false,
          includeInfoText: false,
        },
      ],
    } as unknown as BasePromptConfig;

    const setupMocks = (participants: ParticipantProfileExtended[]) => {
      jest.clearAllMocks();
      (firestoreUtils.getFirestoreExperiment as jest.Mock).mockResolvedValue(
        experiment,
      );
      (firestoreUtils.getFirestoreCohort as jest.Mock).mockResolvedValue(
        cohort,
      );
      (
        firestoreUtils.getFirestoreActiveParticipants as jest.Mock
      ).mockResolvedValue(participants);
      (firestoreUtils.getFirestoreStage as jest.Mock).mockResolvedValue(
        chatStage,
      );
      (
        firestoreUtils.getFirestorePrivateChatMessages as jest.Mock
      ).mockImplementation(async (_exp, privateId) =>
        privateId === human.privateId ? humanMessages : [],
      );
      (
        firestoreUtils.getFirestoreAnswersForStage as jest.Mock
      ).mockResolvedValue([]);
      (
        firestoreUtils.getFirestoreStagePublicData as jest.Mock
      ).mockResolvedValue({});
    };

    it('renders the human and persona agents together in one block', async () => {
      setupMocks([human, persona1, persona2]);
      const prompt = await getPromptFromConfig(
        experimentId,
        cohortId,
        chatStageId,
        mediator,
        promptConfig,
      );
      // The human's chat and both personas' content are in one rendered block.
      expect(prompt).toContain('Private chat with Human (human-1)');
      expect(prompt).toContain('HUMAN_ANSWER_TEXT');
      expect(prompt).toContain('AVERY_CONTENT');
      expect(prompt).toContain('BLAIR_CONTENT');
      // Each persona's content appears exactly once (not duplicated).
      expect(prompt.split('AVERY_CONTENT')).toHaveLength(2);
    });

    it('renders a persona natively for stages where it has a real answer', async () => {
      setupMocks([human, persona1, persona2]);
      const surveyStage = {
        id: chatStageId,
        kind: StageKind.SURVEY,
        name: 'Initial survey',
        descriptions: {primaryText: '', infoText: '', helpText: ''},
        questions: [
          {
            id: 'q1',
            kind: 'scale',
            questionTitle: 'Importance',
            upperValue: 7,
            upperText: 'High',
            lowerValue: 1,
            lowerText: 'Low',
            middleText: '',
            useSlider: false,
            stepSize: 1,
          },
        ],
      };
      (firestoreUtils.getFirestoreStage as jest.Mock).mockResolvedValue(
        surveyStage,
      );
      const answerFor = (p: ParticipantProfileExtended, value: number) => ({
        participantPublicId: p.publicId,
        participantDisplayName: p.name,
        answer: {
          id: chatStageId,
          kind: StageKind.SURVEY,
          answerMap: {q1: {id: 'q1', kind: 'scale', value}},
        },
      });
      // The human and persona1 have real survey answers (persona1's
      // materialized from the bank at claim time); persona2 has none.
      (
        firestoreUtils.getFirestoreAnswersForStage as jest.Mock
      ).mockResolvedValue([answerFor(human, 6), answerFor(persona1, 3)]);
      const prompt = await getPromptFromConfig(
        experimentId,
        cohortId,
        chatStageId,
        mediator,
        {
          ...promptConfig,
          type: StageKind.SURVEY,
          includeScaffoldingInPrompt: true,
        } as unknown as BasePromptConfig,
      );
      // persona1 renders natively via its real answer, not its stored content.
      expect(prompt).toContain("Avery's answers");
      expect(prompt).toContain('Importance: 3');
      expect(prompt).not.toContain('AVERY_CONTENT');
      // persona2 still stands in via its stored content.
      expect(prompt).toContain('BLAIR_CONTENT');
      // The human's answer renders as usual.
      expect(prompt).toContain("Human's answers");
      expect(prompt).toContain('Importance: 6');
    });

    it('is unchanged (real participants only) when no persona agents are present', async () => {
      const human2 = {
        ...human,
        id: 'h2',
        privateId: 'h2-priv',
        publicId: 'human-2',
        name: 'Human2',
      } as unknown as ParticipantProfileExtended;
      setupMocks([human, human2]);
      const prompt = await getPromptFromConfig(
        experimentId,
        cohortId,
        chatStageId,
        mediator,
        promptConfig,
      );
      expect(prompt).toContain('Private chat with Human (human-1)');
      expect(prompt).toContain('Private chat with Human2 (human-2)');
      expect(prompt).not.toContain('isInactivePersona');
    });
  });

  describe('getPromptFromConfig mediator participant variables', () => {
    const experimentId = 'exp';
    const cohortId = 'cohort';
    const stageId = 'stage';
    const utils = jest.requireActual('@deliberation-lab/utils');

    const topicConfig = utils.createRandomPermutationVariableConfig({
      expandListToSeparateVariables: false,
      scope: utils.VariableScope.PARTICIPANT,
      definition: {
        name: 'topic',
        description: '',
        schema: utils.VariableType.array(
          utils.VariableType.object({topicName: utils.VariableType.STRING}),
        ),
      },
    });
    const experiment = {
      id: experimentId,
      stageIds: [stageId],
      variableConfigs: [topicConfig],
      variableMap: {},
    };
    const cohort = {id: cohortId, variableMap: {}};

    const baseParticipant = {
      type: UserType.PARTICIPANT,
      pronouns: null,
      currentCohortId: cohortId,
      currentExperimentId: experimentId,
      currentStageId: stageId,
      timestamps: {
        accountCreated: {seconds: 0, nanoseconds: 0},
        lastLogin: {seconds: 0, nanoseconds: 0},
      },
      prolificId: null,
      transferCohortId: null,
    };
    const human = {
      ...baseParticipant,
      id: 'h',
      privateId: 'h-priv',
      publicId: 'human-1',
      name: 'Human',
      avatar: '🧑',
      agentConfig: null,
      variableMap: {topic: JSON.stringify([{topicName: 'HumanTopic'}])},
    } as unknown as ParticipantProfileExtended;
    const agent = {
      ...baseParticipant,
      id: 'a',
      privateId: 'a-priv',
      publicId: 'agent-1',
      name: 'Agent',
      avatar: '🤖',
      agentConfig: {agentId: 'agent-1', promptContext: ''},
      variableMap: {topic: JSON.stringify([{topicName: 'AgentTopic'}])},
    } as unknown as ParticipantProfileExtended;

    const mediator = {
      id: 'mediator-1',
      privateId: 'mediator-1-priv',
      publicId: 'mediator-1',
      type: UserType.MEDIATOR,
      name: 'Riley',
      avatar: '🤖',
      pronouns: null,
      currentCohortId: cohortId,
      currentExperimentId: experimentId,
      currentStageId: stageId,
      timestamps: {
        accountCreated: {seconds: 0, nanoseconds: 0},
        lastLogin: {seconds: 0, nanoseconds: 0},
      },
      agentConfig: {agentId: 'mediator-1', promptContext: ''},
      prolificId: null,
      transferCohortId: null,
      variableMap: {},
    } as unknown as MediatorProfileExtended;

    const makePromptConfig = (kind: StageKind, text: string) =>
      ({
        type: kind,
        includeScaffoldingInPrompt: false,
        prompt: [{type: PromptItemType.TEXT, text}],
      }) as unknown as BasePromptConfig;

    const setupMocks = (
      stageKind: StageKind,
      participants: ParticipantProfileExtended[],
    ) => {
      jest.clearAllMocks();
      (firestoreUtils.getFirestoreExperiment as jest.Mock).mockResolvedValue(
        experiment,
      );
      (firestoreUtils.getFirestoreCohort as jest.Mock).mockResolvedValue(
        cohort,
      );
      (
        firestoreUtils.getFirestoreActiveParticipants as jest.Mock
      ).mockResolvedValue(participants);
      (firestoreUtils.getFirestoreStage as jest.Mock).mockResolvedValue({
        id: stageId,
        kind: stageKind,
        name: 'Stage',
        descriptions: {primaryText: '', infoText: '', helpText: ''},
      });
      (firestoreUtils.getFirestoreParticipant as jest.Mock).mockImplementation(
        async (_experiment: string, id: string) =>
          participants.find((p) => p.privateId === id),
      );
      (
        firestoreUtils.getFirestorePrivateChatMessages as jest.Mock
      ).mockResolvedValue([]);
      (
        firestoreUtils.getFirestoreAnswersForStage as jest.Mock
      ).mockResolvedValue([]);
      (
        firestoreUtils.getFirestoreStagePublicData as jest.Mock
      ).mockResolvedValue({});
    };

    it('group chat: exposes every participant, humans first', async () => {
      // The agent is listed first; humans-first ordering must still put the
      // human at participant index 0.
      setupMocks(StageKind.CHAT, [agent, human]);
      const prompt = await getPromptFromConfig(
        experimentId,
        cohortId,
        stageId,
        mediator,
        makePromptConfig(
          StageKind.CHAT,
          'A={{topic.0.0.topicName}} B={{topic.1.0.topicName}}',
        ),
      );
      expect(prompt).toContain('A=HumanTopic');
      expect(prompt).toContain('B=AgentTopic');
    });

    it('private chat: exposes the single participant directly', async () => {
      setupMocks(StageKind.PRIVATE_CHAT, [human]);
      const prompt = await getPromptFromConfig(
        experimentId,
        cohortId,
        stageId,
        mediator,
        makePromptConfig(StageKind.PRIVATE_CHAT, 'T={{topic.0.topicName}}'),
        [human.privateId],
      );
      expect(prompt).toContain('T=HumanTopic');
    });
  });
  describe('shouldIncludePromptItem (participant-variable conditions)', () => {
    const variableCondition = (value: string): ComparisonCondition => ({
      id: 'c1',
      type: 'comparison',
      target: {stageId: SYSTEM_VARIABLE_NAMESPACE, questionId: 'treatment'},
      operator: ComparisonOperator.EQUALS,
      value,
    });
    const participant = (treatment: string): ParticipantProfileExtended =>
      ({
        publicId: 'participant-public-1',
        variableMap: {treatment},
      }) as unknown as ParticipantProfileExtended;

    it('includes a private-chat item when the participant variable matches', () => {
      const item = {
        type: PromptItemType.TEXT,
        text: 'x',
        condition: variableCondition('A'),
      };
      expect(
        shouldIncludePromptItem(
          item,
          StageKind.PRIVATE_CHAT,
          [participant('A')],
          {},
        ),
      ).toBe(true);
    });

    it('excludes a private-chat item when the participant variable does not match', () => {
      const item = {
        type: PromptItemType.TEXT,
        text: 'x',
        condition: variableCondition('A'),
      };
      expect(
        shouldIncludePromptItem(
          item,
          StageKind.PRIVATE_CHAT,
          [participant('B')],
          {},
        ),
      ).toBe(false);
    });

    it('includes items with no condition, and does not filter outside private chat', () => {
      const noCond = {type: PromptItemType.TEXT, text: 'x'};
      expect(
        shouldIncludePromptItem(
          noCond,
          StageKind.PRIVATE_CHAT,
          [participant('A')],
          {},
        ),
      ).toBe(true);
      const item = {
        type: PromptItemType.TEXT,
        text: 'x',
        condition: variableCondition('A'),
      };
      expect(
        shouldIncludePromptItem(item, StageKind.CHAT, [participant('B')], {}),
      ).toBe(true);
    });
  });
});
