import {
  onDocumentCreated,
  onDocumentUpdated,
} from 'firebase-functions/v2/firestore';

import {
  ParticipantProfileExtended,
  StageConfig,
  StageKind,
  buildGeneratePersonaPrompt,
  createModelGenerationConfig,
  ModelResponseStatus,
  DEFAULT_AGENT_MODEL_SETTINGS,
} from '@deliberation-lab/utils';
import {startAgentParticipant} from '../agent_participant.utils';
import {
  handleAutomaticTransfer,
  getParticipantRecord,
  initializeParticipantStageAnswers,
} from '../participant.utils';
import {
  getFirestoreParticipant,
  getFirestoreParticipantRef,
  getExperimenterDataFromExperiment,
  getFirestoreStage,
} from '../utils/firestore';
import {getAgentResponse} from '../agent.utils';
import {samplePersonaParams} from '../agent_persona_sampling';
import {getStructuredPromptConfig} from '../structured_prompt.utils';

import {app} from '../app';

/** When participant is created, set participant stage answers. */
export const onParticipantCreation = onDocumentCreated(
  {document: 'experiments/{experimentId}/participants/{participantId}'},
  async (event) => {
    const participant = await getFirestoreParticipant(
      event.params.experimentId,
      event.params.participantId,
    );
    if (!participant) return;

    let activeParticipant = participant;

    // 1. Asynchronously generate persona if flagged
    if (participant.agentConfig && participant.needsPersonaGeneration) {
      const experimentId = event.params.experimentId;
      const experimenterData =
        await getExperimenterDataFromExperiment(experimentId);

      if (experimenterData) {
        const params = samplePersonaParams();
        const prompt = buildGeneratePersonaPrompt(params);
        const generationConfig = createModelGenerationConfig({
          includeReasoning: false,
          providerOptions: {
            google: {thinkingConfig: {thinkingBudget: 0}},
            anthropic: {thinking: {type: 'disabled'}},
          },
        });

        // Fetch stage prompt config to dynamically retrieve configured numRetries
        const stage = await getFirestoreStage(
          experimentId,
          participant.currentStageId,
        );
        const promptConfig = stage
          ? await getStructuredPromptConfig(experimentId, stage, participant)
          : undefined;

        const maxRetries = promptConfig?.numRetries ?? 0;
        const initialDelay = 1000;
        let success = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const response = await getAgentResponse(
              experimenterData.apiKeys,
              prompt,
              DEFAULT_AGENT_MODEL_SETTINGS,
              generationConfig,
            );

            if (response.status === ModelResponseStatus.OK && response.text) {
              await app.firestore().runTransaction(async (transaction) => {
                const pRef = getFirestoreParticipantRef(
                  experimentId,
                  participant.privateId,
                );
                const pDoc = (
                  await transaction.get(pRef)
                ).data() as ParticipantProfileExtended;
                if (pDoc?.agentConfig) {
                  pDoc.agentConfig.promptContext = response.text ?? '';
                  pDoc.connected = true;
                  pDoc.needsPersonaGeneration = false;
                  transaction.set(pRef, pDoc);
                  activeParticipant = pDoc;
                }
              });
              success = true;
              break;
            }

            // Check if we should retry
            const shouldRetry =
              attempt < maxRetries &&
              (response.status ===
                ModelResponseStatus.PROVIDER_UNAVAILABLE_ERROR ||
                response.status === ModelResponseStatus.INTERNAL_ERROR ||
                response.status === ModelResponseStatus.UNKNOWN_ERROR);

            if (!shouldRetry) {
              if (attempt === maxRetries) {
                console.error(
                  `Failed to generate persona context: Non-retryable response status: ${response.status}`,
                );
              }
              break;
            }

            const delay = initialDelay * Math.pow(2, attempt);
            console.log(
              `Persona generation API error (${response.status}), retrying after ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } catch (error) {
            console.error(`Attempt ${attempt} threw error:`, error);
            if (attempt < maxRetries) {
              const delay = initialDelay * Math.pow(2, attempt);
              await new Promise((resolve) => setTimeout(resolve, delay));
            } else {
              break;
            }
          }
        }

        if (!success) {
          console.error(
            `Failed to generate persona context for participant ${participant.privateId} after ${maxRetries} retries. Reverting to base promptContext.`,
          );
          await app.firestore().runTransaction(async (transaction) => {
            const pRef = getFirestoreParticipantRef(
              experimentId,
              participant.privateId,
            );
            const pDoc = (
              await transaction.get(pRef)
            ).data() as ParticipantProfileExtended;
            if (pDoc?.agentConfig) {
              pDoc.connected = true;
              pDoc.needsPersonaGeneration = false;
              transaction.set(pRef, pDoc);
              activeParticipant = pDoc;
            }
          });
        }
      }
    }

    // Set up participant stage answers
    initializeParticipantStageAnswers(
      event.params.experimentId,
      activeParticipant,
    );

    // Start making agent calls for participants with agent configs
    startAgentParticipant(event.params.experimentId, activeParticipant);
  },
);

/** Trigger when a disconnected participant reconnects. */
export const onParticipantReconnect = onDocumentUpdated(
  {
    document: 'experiments/{experimentId}/participants/{participantId}',
  },
  async (event) => {
    if (!event.data) return;
    const experimentId = event.params.experimentId;
    const participantId = event.params.participantId;

    const before = event.data.before.data() as ParticipantProfileExtended;
    const after = event.data.after.data() as ParticipantProfileExtended;

    // Check if participant reconnected
    if (!before.connected && after.connected) {
      const firestore = app.firestore();
      // Fetch the participant's current stage config (outside transaction)
      const stageDocPrecheck = firestore
        .collection('experiments')
        .doc(experimentId)
        .collection('stages')
        .doc(after.currentStageId);
      const stageConfigPrecheck = (
        await stageDocPrecheck.get()
      ).data() as StageConfig;

      if (stageConfigPrecheck?.kind === StageKind.TRANSFER) {
        // Wait 10 seconds before running the transaction, to make sure user's connection is
        // relatively stable
        await new Promise((resolve) => setTimeout(resolve, 10000));
        await firestore.runTransaction(async (transaction) => {
          // Fetch the participant's current stage config again (inside transaction)
          const stageDoc = firestore
            .collection('experiments')
            .doc(experimentId)
            .collection('stages')
            .doc(after.currentStageId);
          const stageConfig = (
            await transaction.get(stageDoc)
          ).data() as StageConfig;

          if (stageConfig?.kind === StageKind.TRANSFER) {
            const participant = await getParticipantRecord(
              transaction,
              experimentId,
              participantId,
            );

            if (!participant) {
              throw new Error('Participant not found');
            }

            // Ensure participant is still connected after the delay
            if (!participant.connected) {
              console.log(
                `Participant ${participantId} is no longer connected after delay, skipping transfer.`,
              );
              return;
            }

            const transferResult = await handleAutomaticTransfer(
              transaction,
              experimentId,
              stageConfig,
              participant,
            );
            if (transferResult) {
              // Store any updates to participant after transfer
              const participantDoc = app
                .firestore()
                .collection('experiments')
                .doc(experimentId)
                .collection('participants')
                .doc(participant.privateId);
              transaction.set(participantDoc, participant);
            }
          }
        });
      }
    }
  },
);
