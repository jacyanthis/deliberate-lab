/**
 * Data download utilities for Firebase Admin SDK
 */

import {FieldPath, Firestore, Query} from 'firebase-admin/firestore';
import {
  AgentMediatorPersonaConfig,
  AgentMediatorTemplate,
  AgentParticipantPersonaConfig,
  AgentParticipantTemplate,
  AlertMessage,
  ChatMessage,
  CohortConfig,
  createCohortDownload,
  createExperimentDownload,
  createParticipantDownload,
  DEFAULT_LOGS_PAGE_SIZE,
  Experiment,
  ExperimentDownload,
  LogEntry,
  MediatorPromptConfig,
  ParticipantProfileExtended,
  ParticipantPromptConfig,
  ParticipantThought,
  StageConfig,
  StageKind,
  StageParticipantAnswer,
  StagePublicData,
  UnifiedTimestamp,
} from '@deliberation-lab/utils';
import {convertTimestamps} from './data.utils';

/**
 * Options for getExperimentDownload
 */
export interface GetExperimentDownloadOptions {
  /** Whether to include participant, cohort, and alert data. Defaults to true. */
  includeParticipantData?: boolean;
  /**
   * Return at most this many participants, so a study too large to assemble in
   * one response can be walked a page at a time. The download then carries
   * nextParticipantCursor, which is the id to pass as participantCursor for the
   * page after this one, or null at the end.
   */
  participantLimit?: number;
  /** Participant id to continue after; see participantLimit. */
  participantCursor?: string;
  /** The same for cohorts, whose public stage data is the other large part. */
  cohortLimit?: number;
  cohortCursor?: string;
  /**
   * Participants the caller already holds from an earlier export, by public or
   * private id; they are left out of this download, so a repeated export of a
   * growing study only carries the people the caller does not have yet. The
   * persona banks are left out too, since a caller with an earlier export has
   * them. Cannot be combined with the limit and cursor options.
   */
  excludeParticipantIds?: string[];
  /** The same for cohorts, by cohort id. */
  excludeCohortIds?: string[];
  /**
   * Assemble participants and cohorts a batch at a time instead of one at a
   * time, and skip the per-stage reads that cannot hold anything. Off by
   * default: the download is the same either way, so this only matters once an
   * experiment is large enough for the one-at-a-time walk to be slow.
   */
  fast?: boolean;
}

/**
 * How many participants or cohorts the fast path has in flight at once. Small
 * enough to stay well inside the client's connection limits, large enough that
 * the round trips stop being the cost.
 */
const FAST_BATCH_SIZE = 25;

/** Run `work` over `items`, `size` at a time, keeping the order of the input. */
async function inBatches<Item, Result>(
  items: Item[],
  size: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  if (size <= 1) {
    const results: Result[] = [];
    for (const item of items) {
      results.push(await work(item));
    }
    return results;
  }
  const results: Result[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(
      ...(await Promise.all(items.slice(index, index + size).map(work))),
    );
  }
  return results;
}

/**
 * Build a complete ExperimentDownload structure using Firebase Admin SDK.
 *
 * @param firestore - Firestore instance from firebase-admin/firestore
 * @param experimentId - ID of the experiment to download
 * @param options - Options for what data to include
 * @returns Complete experiment download data, or null if experiment not found
 */
export async function getExperimentDownload(
  firestore: Firestore,
  experimentId: string,
  options: GetExperimentDownloadOptions = {},
): Promise<ExperimentDownload | null> {
  const {
    includeParticipantData = true,
    fast = false,
    participantLimit,
    participantCursor,
    cohortLimit,
    cohortCursor,
    excludeParticipantIds,
    excludeCohortIds,
  } = options;
  const excludedParticipants = new Set(excludeParticipantIds ?? []);
  const excludedCohorts = new Set(excludeCohortIds ?? []);
  const isIncremental =
    excludedParticipants.size > 0 || excludedCohorts.size > 0;
  const batchSize = fast ? FAST_BATCH_SIZE : 1;

  // Get experiment config from experimentId
  const experimentConfig = (
    await firestore.collection('experiments').doc(experimentId).get()
  ).data() as Experiment | undefined;

  if (!experimentConfig) {
    return null;
  }

  // Create experiment download using experiment config
  const experimentDownload = createExperimentDownload(experimentConfig);

  // For each experiment stage config, add to ExperimentDownload
  const stageConfigs = (
    await firestore
      .collection('experiments')
      .doc(experimentId)
      .collection('stages')
      .get()
  ).docs.map((doc) => doc.data() as StageConfig);
  for (const stage of stageConfigs) {
    experimentDownload.stageMap[stage.id] = stage;
  }

  // For each agent mediator, add template
  const mediatorAgents = (
    await firestore
      .collection('experiments')
      .doc(experimentId)
      .collection('agentMediators')
      .get()
  ).docs.map((agent) => agent.data() as AgentMediatorPersonaConfig);
  for (const persona of mediatorAgents) {
    const mediatorPrompts = (
      await firestore
        .collection('experiments')
        .doc(experimentId)
        .collection('agentMediators')
        .doc(persona.id)
        .collection('prompts')
        .get()
    ).docs.map((doc) => doc.data() as MediatorPromptConfig);
    const mediatorTemplate: AgentMediatorTemplate = {
      persona,
      promptMap: {},
    };
    mediatorPrompts.forEach((prompt) => {
      mediatorTemplate.promptMap[prompt.id] = prompt;
    });
    // Add to ExperimentDownload
    experimentDownload.agentMediatorMap[persona.id] = mediatorTemplate;
  }

  // For each agent participant, add template
  const participantAgents = (
    await firestore
      .collection('experiments')
      .doc(experimentId)
      .collection('agentParticipants')
      .get()
  ).docs.map((agent) => agent.data() as AgentParticipantPersonaConfig);
  for (const persona of participantAgents) {
    const participantPrompts = (
      await firestore
        .collection('experiments')
        .doc(experimentId)
        .collection('agentParticipants')
        .doc(persona.id)
        .collection('prompts')
        .get()
    ).docs.map((doc) => doc.data() as ParticipantPromptConfig);
    const participantTemplate: AgentParticipantTemplate = {
      persona,
      promptMap: {},
    };
    participantPrompts.forEach((prompt) => {
      participantTemplate.promptMap[prompt.id] = prompt;
    });
    // Add to ExperimentDownload
    experimentDownload.agentParticipantMap[persona.id] = participantTemplate;
  }

  // Persona banks, when present. Included so the per-participant persona
  // assignment (recorded on each doc's usedBy) is recoverable from the
  // download; skipped entirely for experiments with no bank. A caller walking
  // the experiment in pages has them already, so they are sent with the first
  // page only rather than repeated on every one.
  const isLaterPage =
    Boolean(participantCursor || cohortCursor) || isIncremental;
  const personaBankDocs = isLaterPage
    ? []
    : (
        await firestore
          .collection('experiments')
          .doc(experimentId)
          .collection('personas')
          .get()
      ).docs;
  if (personaBankDocs.length > 0) {
    experimentDownload.personaBankMap = {};
    for (const doc of personaBankDocs) {
      experimentDownload.personaBankMap[doc.id] = doc.data();
    }
  }
  const repPersonaBankDocs = isLaterPage
    ? []
    : (
        await firestore
          .collection('experiments')
          .doc(experimentId)
          .collection('repPersonas')
          .get()
      ).docs;
  if (repPersonaBankDocs.length > 0) {
    experimentDownload.repPersonaBankMap = {};
    for (const doc of repPersonaBankDocs) {
      experimentDownload.repPersonaBankMap[doc.id] = doc.data();
    }
  }

  // A page request asks for one collection at a time. Passing a participant
  // cursor asks for the next participants and nothing else; passing a cohort
  // cursor asks for the next cohorts and nothing else. Without a cursor the
  // caller gets the first page of both, along with the parts that are sent
  // once. Answering with both on every request would restart whichever
  // collection had already finished, since "no cursor" and "finished" cannot
  // be told apart.
  const wantParticipants = !cohortCursor;
  const wantCohorts = !participantCursor;

  if (includeParticipantData) {
    // For each participant, add ParticipantDownload
    // One page of participants when a limit is asked for, ordered by document
    // id so a cursor can pick up exactly where the last page stopped. Without
    // a limit this reads them all, as it always has.
    let participantQuery: Query = firestore
      .collection('experiments')
      .doc(experimentId)
      .collection('participants');
    if (participantLimit) {
      participantQuery = participantQuery.orderBy(FieldPath.documentId());
      if (participantCursor) {
        participantQuery = participantQuery.startAfter(participantCursor);
      }
      participantQuery = participantQuery.limit(participantLimit);
    }
    const participantDocs = wantParticipants
      ? (await participantQuery.get()).docs
      : [];
    if (participantLimit && wantParticipants) {
      experimentDownload.nextParticipantCursor =
        participantDocs.length === participantLimit
          ? participantDocs[participantDocs.length - 1].id
          : null;
    }
    const profiles = participantDocs
      .map((doc) => doc.data() as ParticipantProfileExtended)
      .filter(
        (profile) =>
          !excludedParticipants.has(profile.publicId) &&
          !excludedParticipants.has(profile.privateId),
      );
    // Stages that can hold in-chat thoughts or private-chat messages, in the
    // experiment's own stage order so the download reads the same either way.
    // The one-at-a-time path keeps asking every stage, as it always has.
    const stageKinds = new Map(
      stageConfigs.map((stage) => [stage.id, stage.kind]),
    );
    const conversationStageIds = (experimentConfig.stageIds || []).filter(
      (stageId) =>
        stageKinds.get(stageId) === StageKind.CHAT ||
        stageKinds.get(stageId) === StageKind.PRIVATE_CHAT,
    );

    const participantDownloads = await inBatches(
      profiles,
      batchSize,
      async (profile) => {
        // Create new ParticipantDownload
        const participantDownload = createParticipantDownload(profile);

        // For each stage answer, add to ParticipantDownload map
        const stageAnswers = (
          await firestore
            .collection('experiments')
            .doc(experimentId)
            .collection('participants')
            .doc(profile.privateId)
            .collection('stageData')
            .get()
        ).docs.map((doc) => doc.data() as StageParticipantAnswer);
        for (const stage of stageAnswers) {
          participantDownload.answerMap[stage.id] = stage;
        }

        // Spawned agents never hold thoughts or private chats, so the fast path
        // does not ask for theirs.
        const isAgent = Boolean(profile.agentConfig);
        const stageIdsWithThoughts = fast
          ? isAgent
            ? []
            : conversationStageIds
          : experimentConfig.stageIds || [];
        const thoughtsQueries = stageIdsWithThoughts.map(async (stageId) => {
          const thoughtsList = (
            await firestore
              .collection('experiments')
              .doc(experimentId)
              .collection('participants')
              .doc(profile.privateId)
              .collection('stageData')
              .doc(stageId)
              .collection('thoughts')
              .orderBy('timestamp', 'asc')
              .get()
          ).docs.map((thoughtDoc) => thoughtDoc.data() as ParticipantThought);

          return {stageId, thoughtsList};
        });

        const thoughtsResults = await Promise.all(thoughtsQueries);
        for (const {stageId, thoughtsList} of thoughtsResults) {
          if (thoughtsList.length > 0) {
            participantDownload.thoughtMap[stageId] = thoughtsList;
          }
        }

        // Fetch private-chat (e.g. interview) messages for all stages in
        // parallel. Private chats live in a per-participant subcollection and
        // were previously excluded from the download, so interviews could not be
        // recovered from the export.
        const privateChatQueries = stageIdsWithThoughts.map(async (stageId) => {
          const messages = (
            await firestore
              .collection('experiments')
              .doc(experimentId)
              .collection('participants')
              .doc(profile.privateId)
              .collection('stageData')
              .doc(stageId)
              .collection('privateChats')
              .orderBy('timestamp', 'asc')
              .get()
          ).docs.map((chatDoc) => chatDoc.data() as ChatMessage);
          return {stageId, messages};
        });
        const privateChatResults = await Promise.all(privateChatQueries);
        for (const {stageId, messages} of privateChatResults) {
          if (messages.length > 0) {
            participantDownload.privateChatMap[stageId] = messages;
          }
        }

        return participantDownload;
      },
    );
    for (const [index, profile] of profiles.entries()) {
      // Added in the order the profiles came back, so the download reads the
      // same whichever path built it.
      experimentDownload.participantMap[profile.publicId] =
        participantDownloads[index];
    }

    // For each cohort, add CohortDownload, a page at a time when asked.
    let cohortQuery: Query = firestore
      .collection('experiments')
      .doc(experimentId)
      .collection('cohorts');
    if (cohortLimit) {
      cohortQuery = cohortQuery.orderBy(FieldPath.documentId());
      if (cohortCursor) {
        cohortQuery = cohortQuery.startAfter(cohortCursor);
      }
      cohortQuery = cohortQuery.limit(cohortLimit);
    }
    const cohortDocs = wantCohorts ? (await cohortQuery.get()).docs : [];
    if (cohortLimit && wantCohorts) {
      experimentDownload.nextCohortCursor =
        cohortDocs.length === cohortLimit
          ? cohortDocs[cohortDocs.length - 1].id
          : null;
    }
    const cohorts = cohortDocs
      .map((cohort) => cohort.data() as CohortConfig)
      .filter((cohort) => !excludedCohorts.has(cohort.id));
    const cohortDownloads = await inBatches(
      cohorts,
      batchSize,
      async (cohort) => {
        // Create new CohortDownload
        const cohortDownload = createCohortDownload(cohort);

        // For each public stage data, add to CohortDownload
        const publicStageData = (
          await firestore
            .collection('experiments')
            .doc(experimentId)
            .collection('cohorts')
            .doc(cohort.id)
            .collection('publicStageData')
            .get()
        ).docs.map((doc) => doc.data() as StagePublicData);
        const chatLists = await inBatches(
          publicStageData,
          batchSize,
          async (data) => {
            // If chat stage, add list of chat messages to CohortDownload
            if (data.kind !== StageKind.CHAT) {
              return null;
            }
            return (
              await firestore
                .collection('experiments')
                .doc(experimentId)
                .collection('cohorts')
                .doc(cohort.id)
                .collection('publicStageData')
                .doc(data.id)
                .collection('chats')
                .orderBy('timestamp', 'asc')
                .get()
            ).docs.map((doc) => doc.data() as ChatMessage);
          },
        );
        for (const [index, data] of publicStageData.entries()) {
          cohortDownload.dataMap[data.id] = data;
          const chatList = chatLists[index];
          if (chatList) {
            cohortDownload.chatMap[data.id] = chatList;
          }
        }

        return cohortDownload;
      },
    );
    for (const [index, cohort] of cohorts.entries()) {
      experimentDownload.cohortMap[cohort.id] = cohortDownloads[index];
    }

    // Add alerts to ExperimentDownload, with the first page rather than again
    // on every one.
    const alertList = isLaterPage
      ? []
      : (
          await firestore
            .collection('experiments')
            .doc(experimentId)
            .collection('alerts')
            .orderBy('timestamp', 'asc')
            .get()
        ).docs.map((doc) => doc.data() as AlertMessage);

    // Group alerts by participant private ID
    for (const alert of alertList) {
      const participantId = alert.participantId;
      if (!experimentDownload.alerts[participantId]) {
        experimentDownload.alerts[participantId] = [];
      }
      experimentDownload.alerts[participantId].push(alert);
    }
  }

  // Convert all Timestamp objects to UnifiedTimestamp format
  const normalized = convertTimestamps(
    experimentDownload,
  ) as ExperimentDownload;
  return normalized;
}

/**
 * Options for getExperimentLogs pagination.
 */
export interface GetExperimentLogsOptions {
  /** Cursor for pagination: the createdTimestamp of the last entry in the
   *  previous page. Omit to start from the beginning. */
  cursor?: UnifiedTimestamp;
  /** Max entries to return per page. Defaults to DEFAULT_LOGS_PAGE_SIZE. */
  limit?: number;
}

/**
 * Fetch log entries for an experiment using Firebase Admin SDK.
 * Supports cursor-based pagination to avoid exceeding the ~32 MB
 * Cloud Functions onCall response size limit.
 *
 * @param firestore - Firestore instance from firebase-admin/firestore
 * @param experimentId - ID of the experiment
 * @param options - Pagination options (cursor and limit)
 * @returns Array of log entries ordered by createdTimestamp, or null if experiment not found
 */
export async function getExperimentLogs(
  firestore: Firestore,
  experimentId: string,
  options: GetExperimentLogsOptions = {},
): Promise<LogEntry[] | null> {
  const pageSize = options.limit ?? DEFAULT_LOGS_PAGE_SIZE;

  // Verify experiment exists
  const experimentDoc = await firestore
    .collection('experiments')
    .doc(experimentId)
    .get();

  if (!experimentDoc.exists) {
    return null;
  }

  // Build paginated query
  let logsQuery: Query = firestore
    .collection('experiments')
    .doc(experimentId)
    .collection('logs')
    .orderBy('createdTimestamp', 'asc')
    .limit(pageSize);

  if (options.cursor) {
    const cursorMs =
      options.cursor.seconds * 1000 +
      Math.floor(options.cursor.nanoseconds / 1e6);
    logsQuery = logsQuery.startAfter(new Date(cursorMs));
  }

  // Fetch paginated logs
  const logs = (await logsQuery.get()).docs.map(
    (doc) => doc.data() as LogEntry,
  );

  // Convert all Timestamp objects to UnifiedTimestamp format
  return convertTimestamps(logs) as LogEntry[];
}
