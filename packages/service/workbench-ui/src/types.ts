/** Read projections of the ACP execution ledger, separate from ProjectItem. */
export type AcpTaskFilter = 'all' | 'pending' | 'working' | 'failed';
export type AcpReviewAction = 'comment' | 'approve' | 'changes_requested' | 'cancel';
export type AcpReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'superseded' | 'canceled';

export interface AcpJobRef {
    sourceId: string;
    jobId: string;
}
/** Safe identity fields from the execution attempt's frozen target snapshot. */
export interface AcpExecution {
    kind: 'temporary' | 'resident' | 'workflow' | 'unknown';
    targetId: string;
    targetName?: string;
    roleId?: string;
    agentPreset?: string;
    presetStatus: 'recorded' | 'host_default' | 'unknown' | 'not_applicable';
    service?: string;
    serviceInfo?: {
        kind: 'a2a' | 'gateway_workflow' | 'activepieces' | 'unknown';
        source: 'backend_run' | 'target_snapshot' | 'workflow_run' | 'unrecorded';
        host?: string;
        port?: number;
        locality?: 'loopback' | 'network';
        connectionAlias?: string;
    };
    provider?: string;
    connectionId?: string;
}
export interface AcpTaskSummary {
    jobId: string;
    sourceId: string;
    title?: string;
    originSessionId: string;
    parentJobRef?: AcpJobRef;
    parentAttemptId?: string;
    purpose?: string;
    targetId: string;
    execution?: AcpExecution;
    executionStatus: string;
    displayStatus?: string;
    phase?: string;
    createdAt?: string | null;
    updatedAt: string;
    stale?: boolean;
    reviewStatus?: AcpReviewStatus;
    currentAttemptId: string;
    progressSummary?: string;
    pendingReviewId?: string;
    pendingProcessRequestId?: string;
    channel?: 'trial' | 'formal' | 'standalone';
    agentId?: string;
    agentName?: string;
    agentPhase?: 'developing' | 'published';
    resultRevision?: string;
    inFlightAttemptIds?: string[];
    unresolvedAttemptIds?: string[];
    businessAcceptance?: AcpBusinessAcceptance;
    blockedTools?: string[];
}

export interface AcpBusinessAcceptance {
    attemptId: string;
    resultRevision: string;
    resultDigest: string;
    reviewStatus: 'pending' | 'accepted' | 'changes_requested';
    note?: string;
    recordedAt: string;
}

export interface AcpTaskList {
    items: AcpTaskSummary[];
    total: number;
    counts: Record<AcpTaskFilter, number>;
    offset: number;
    limit: number;
}

export interface AcpArtifact {
    path?: string;
    url?: string;
    mediaType?: string;
    sha256?: string;
}
export interface AcpAttempt {
    attemptId: string;
    jobId: string;
    previousAttemptId?: string;
    targetId?: string;
    execution?: AcpExecution;
    executionStatus: string;
    submissionStatus?: string;
    createdAt?: string | null;
    updatedAt?: string;
    checkedAt?: string;
    stale?: boolean;
    diagnostic?: string;
    phase?: string;
    result?: {
        resultSummary?: string;
        resultRevision?: string;
        artifactLinks?: AcpArtifact[];
        resultAvailable?: boolean;
    };
}

export interface AcpReviewEvent {
    action: AcpReviewAction;
    note?: string;
    actor: { id: string; displayName?: string; source: string };
    at: string;
}
export interface AcpScriptSlide {
    title: string;
    message: string;
    body: string[];
    visual: string;
    sources: string[];
    facts: string[];
    notes: string;
}
export interface AcpReview {
    reviewId: string;
    jobId: string;
    status: AcpReviewStatus;
    revision: string;
    digest: string;
    attemptId: string;
    authorAttemptId?: string;
    title?: string;
    createdAt: string;
    updatedAt?: string;
    preview: { title: string; slides: AcpScriptSlide[]; kind?: 'markdown'; markdown?: string; reportPath?: string };
    history: AcpReviewEvent[];
    canReview?: boolean;
    resumeStatus?: 'pending' | 'applied' | 'processing' | 'completed' | 'failed';
    resumeError?: string;
}
export interface AcpProgressStage {
    stage: string;
    name: string;
    status: string;
    jobId?: string;
    attemptId?: string;
    planned?: boolean;
}
export interface AcpProgress {
    stage?: string;
    phase?: string;
    executionStatus?: string;
    stages: AcpProgressStage[];
    completedStages?: string[];
    remainingStages?: string[];
    availableResults?: {
        revision: string;
        artifacts: AcpArtifact[];
        deliveryReady?: boolean;
        independentReview?: string;
    }[];
    executionElapsedMs?: number;
    humanWaitingMs?: number;
    updatedAt?: string;
}
export interface AcpTaskEvent {
    eventId: string;
    type: string;
    observedAt: string;
    attemptId?: string;
    data?: unknown;
}
export interface AcpDependency {
    from: string;
    to: string;
    kind: 'parent' | 'depends_on' | 'replaces';
    label?: string;
}
export interface AcpProcessQuestion {
    id: string;
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
}
export interface AcpProcessRequest {
    requestId: string;
    jobId: string;
    attemptId: string;
    kind: 'question' | 'plan' | 'permission';
    questions?: AcpProcessQuestion[];
    planContent?: string;
    toolTitle?: string;
    toolDetail?: string;
    status: 'pending' | 'answered' | 'cancelled' | 'expired';
    deadlineAt: string;
    canAnswer?: boolean;
    answer?: { clientRequestId: string; outcome: string; answers?: Record<string, string | string[]>; note?: string; stopTask?: true };
}
export interface AcpAgentOption {
    id: string;
    value: string;
    model?: true;
}
export interface AcpAgentRow {
    agentId: string;
    name: string;
    phase: 'developing' | 'published';
    origin: 'draft' | 'release' | 'resident';
    acpAgent?: string;
    roleId?: string;
    targetId?: string;
    agentPreset?: string;
    modeId?: string;
    options: AcpAgentOption[];
    releaseName?: string;
    sourceAgentId?: string;
    counterpartId?: string;
    taskCount: number;
    pendingCount: number;
}
export interface AcpAgentCatalog {
    developing: AcpAgentRow[];
    published: AcpAgentRow[];
}
export interface AcpAgentDraftInput {
    name?: string;
    acpAgent?: string;
    roleId?: string;
    targetId?: string;
    modeId?: string;
    options?: AcpAgentOption[];
}
export interface AcpProcessAnswerInput {
    clientRequestId: string;
    outcome: 'accepted' | 'cancelled' | 'approved' | 'rejected' | 'abandoned';
    answers?: Record<string, string | string[]>;
    note?: string;
    stopTask?: true;
}
export interface AcpTaskDetail extends AcpTaskSummary {
    attempts: AcpAttempt[];
    children: AcpTaskSummary[];
    ancestors?: AcpTaskSummary[];
    progress?: AcpProgress;
    reviews: AcpReview[];
    processRequests?: AcpProcessRequest[];
    events: AcpTaskEvent[];
    dependencies?: AcpDependency[];
    artifacts?: { revision: string; digest?: string; artifacts: unknown[] }[];
}
export interface AcpDecisionInput {
    action: AcpReviewAction;
    revision: string;
    digest: string;
    clientRequestId: string;
    note?: string;
}

export interface AcpChatPage {
    items: { id: string; createdAt: number; kind: 'user' | 'assistant_text'; content: string }[];
    hasMore: boolean;
    nextCursor?: string;
    total: number;
}
