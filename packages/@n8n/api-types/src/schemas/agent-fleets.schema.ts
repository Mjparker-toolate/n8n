import { z } from 'zod';

import { jsonValueSchema } from './json-value.schema';
import { Z } from '../zod-class';

/**
 * Fleet protocols sit on the existing n8n agents module. A fleet member is an
 * existing agent. This module does not own identity, tools, memory, or model
 * execution.
 */

export const FLEET_NAME_MAX_LENGTH = 128;
export const FLEET_DESCRIPTION_MAX_LENGTH = 2_000;
export const FLEET_SPECIALIZATION_MAX_LENGTH = 512;
export const FLEET_MAX_MEMBERS = 50;
export const FLEET_MAX_TOOLS_PER_MEMBER = 50;
export const FLEET_MAX_GRAPH_NODES = 100;
export const FLEET_MAX_DEPENDS_ON = 50;
export const FLEET_INSTRUCTION_MAX_LENGTH = 10_000;
export const FLEET_NODE_ID_MAX_LENGTH = 64;
export const FLEET_AGENT_ID_MAX_LENGTH = 64;
export const FLEET_TOOL_ID_MAX_LENGTH = 128;
export const FLEET_RETRY_MAX_ATTEMPTS = 5;
export const FLEET_RETRY_MAX_BACKOFF_MS = 60_000;
export const FLEET_FEEDBACK_COMMENT_MAX_LENGTH = 4_000;

export const FLEET_AGENT_ROLES = ['coordinator', 'specialist'] as const;
export const fleetAgentRoleSchema = z.enum(FLEET_AGENT_ROLES);
export type FleetAgentRole = z.infer<typeof fleetAgentRoleSchema>;

export const FLEET_AGENT_LIFECYCLES = ['draft', 'active', 'retired'] as const;
export const fleetAgentLifecycleSchema = z.enum(FLEET_AGENT_LIFECYCLES);
export type FleetAgentLifecycle = z.infer<typeof fleetAgentLifecycleSchema>;

export const FLEET_MEMORY_SCOPES = ['none', 'observational', 'episodic'] as const;
export const fleetMemoryScopeSchema = z.enum(FLEET_MEMORY_SCOPES);
export type FleetMemoryScope = z.infer<typeof fleetMemoryScopeSchema>;

export const FLEET_TASK_NODE_KINDS = ['coordinator', 'task', 'fan-out', 'fan-in'] as const;
export const fleetTaskNodeKindSchema = z.enum(FLEET_TASK_NODE_KINDS);
export type FleetTaskNodeKind = z.infer<typeof fleetTaskNodeKindSchema>;

export const FLEET_RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export const fleetRunStatusSchema = z.enum(FLEET_RUN_STATUSES);
export type FleetRunStatus = z.infer<typeof fleetRunStatusSchema>;

export const FLEET_NODE_STATUSES = [
	'pending',
	'running',
	'succeeded',
	'failed',
	'cancelled',
] as const;
export const fleetNodeStatusSchema = z.enum(FLEET_NODE_STATUSES);
export type FleetNodeStatus = z.infer<typeof fleetNodeStatusSchema>;

export const FLEET_MESSAGE_TYPES = [
	'task.assign',
	'task.result',
	'task.fail',
	'task.cancel',
	'coordination.ask',
	'coordination.reply',
] as const;
export const fleetMessageTypeSchema = z.enum(FLEET_MESSAGE_TYPES);
export type FleetMessageType = z.infer<typeof fleetMessageTypeSchema>;

export const FLEET_FEEDBACK_RATINGS = ['up', 'down'] as const;
export const fleetFeedbackRatingSchema = z.enum(FLEET_FEEDBACK_RATINGS);
export type FleetFeedbackRating = z.infer<typeof fleetFeedbackRatingSchema>;

const agentIdSchema = z.string().trim().min(1).max(FLEET_AGENT_ID_MAX_LENGTH);
const nodeIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(FLEET_NODE_ID_MAX_LENGTH)
	.regex(/^[A-Za-z0-9_-]+$/, 'Node id can only contain letters, numbers, hyphens, and underscores');
const toolIdSchema = z.string().trim().min(1).max(FLEET_TOOL_ID_MAX_LENGTH);

const fleetAgentSpecShape = {
	agentId: agentIdSchema,
	role: fleetAgentRoleSchema,
	specialization: z.string().trim().min(1).max(FLEET_SPECIALIZATION_MAX_LENGTH),
	tools: z.array(toolIdSchema).max(FLEET_MAX_TOOLS_PER_MEMBER),
	memoryScope: fleetMemoryScopeSchema,
	lifecycle: fleetAgentLifecycleSchema,
};

export const fleetAgentSpecSchema = z.object(fleetAgentSpecShape).strict();
export type FleetAgentSpec = z.infer<typeof fleetAgentSpecSchema>;

const createAgentFleetShape = {
	name: z.string().trim().min(1).max(FLEET_NAME_MAX_LENGTH),
	description: z.string().trim().max(FLEET_DESCRIPTION_MAX_LENGTH).optional(),
	coordinatorAgentId: agentIdSchema,
	members: z.array(fleetAgentSpecSchema).min(1).max(FLEET_MAX_MEMBERS),
};

export const createAgentFleetSchema = z.object(createAgentFleetShape).strict();
export type CreateAgentFleetPayload = z.infer<typeof createAgentFleetSchema>;
export class CreateAgentFleetDto extends Z.class(createAgentFleetShape, { strict: true }) {}

export class AddAgentFleetMemberDto extends Z.class(fleetAgentSpecShape, { strict: true }) {}

const updateAgentFleetMemberShape = {
	specialization: z.string().trim().min(1).max(FLEET_SPECIALIZATION_MAX_LENGTH).optional(),
	tools: z.array(toolIdSchema).max(FLEET_MAX_TOOLS_PER_MEMBER).optional(),
	memoryScope: fleetMemoryScopeSchema.optional(),
	lifecycle: fleetAgentLifecycleSchema.optional(),
};

export const updateAgentFleetMemberSchema = z.object(updateAgentFleetMemberShape).strict();
export class UpdateAgentFleetMemberDto extends Z.class(updateAgentFleetMemberShape, {
	strict: true,
}) {}

const fleetTaskRetryShape = {
	maxAttempts: z.number().int().min(1).max(FLEET_RETRY_MAX_ATTEMPTS),
	backoffMs: z.number().int().min(0).max(FLEET_RETRY_MAX_BACKOFF_MS),
};

export const fleetTaskRetrySchema = z.object(fleetTaskRetryShape).strict();
export type FleetTaskRetry = z.infer<typeof fleetTaskRetrySchema>;

const fleetTaskNodeShape = {
	id: nodeIdSchema,
	agentId: agentIdSchema,
	kind: fleetTaskNodeKindSchema,
	instruction: z.string().trim().min(1).max(FLEET_INSTRUCTION_MAX_LENGTH),
	dependsOn: z.array(nodeIdSchema).max(FLEET_MAX_DEPENDS_ON).default([]),
	retry: fleetTaskRetrySchema.optional(),
};

export const fleetTaskNodeSchema = z.object(fleetTaskNodeShape).strict();
export type FleetTaskNode = z.infer<typeof fleetTaskNodeSchema>;

const createAgentFleetRunShape = {
	nodes: z.array(fleetTaskNodeSchema).min(1).max(FLEET_MAX_GRAPH_NODES),
};

export const createAgentFleetRunSchema = z.object(createAgentFleetRunShape).strict();
export type CreateAgentFleetRunPayload = z.infer<typeof createAgentFleetRunSchema>;
export class CreateAgentFleetRunDto extends Z.class(createAgentFleetRunShape, { strict: true }) {}

const sendAgentFleetMessageShape = {
	fromAgentId: agentIdSchema,
	toAgentId: agentIdSchema,
	type: fleetMessageTypeSchema,
	payload: jsonValueSchema,
};

export const sendAgentFleetMessageSchema = z.object(sendAgentFleetMessageShape).strict();
export type SendAgentFleetMessagePayload = z.infer<typeof sendAgentFleetMessageSchema>;
export class SendAgentFleetMessageDto extends Z.class(sendAgentFleetMessageShape, {
	strict: true,
}) {}

const createAgentFleetFeedbackShape = {
	agentId: agentIdSchema,
	runId: z.string().trim().min(1).max(64).optional(),
	evalRunId: z.string().trim().min(1).max(64).optional(),
	rating: fleetFeedbackRatingSchema,
	comment: z.string().trim().max(FLEET_FEEDBACK_COMMENT_MAX_LENGTH).optional(),
};

export const createAgentFleetFeedbackSchema = z.object(createAgentFleetFeedbackShape).strict();
export type CreateAgentFleetFeedbackPayload = z.infer<typeof createAgentFleetFeedbackSchema>;
export class CreateAgentFleetFeedbackDto extends Z.class(createAgentFleetFeedbackShape, {
	strict: true,
}) {}

const applyAgentFleetSpecializationShape = {
	agentId: agentIdSchema,
	specialization: z.string().trim().min(1).max(FLEET_SPECIALIZATION_MAX_LENGTH).optional(),
	tools: z.array(toolIdSchema).max(FLEET_MAX_TOOLS_PER_MEMBER).optional(),
	memoryScope: fleetMemoryScopeSchema.optional(),
};

export const applyAgentFleetSpecializationSchema = z
	.object(applyAgentFleetSpecializationShape)
	.strict();
export type ApplyAgentFleetSpecializationPayload = z.infer<
	typeof applyAgentFleetSpecializationSchema
>;
export class ApplyAgentFleetSpecializationDto extends Z.class(applyAgentFleetSpecializationShape, {
	strict: true,
}) {}

export type AgentFleetRecord = {
	id: string;
	projectId: string;
	name: string;
	description: string | null;
	coordinatorAgentId: string;
	members: FleetAgentSpec[];
	createdAt: string;
	updatedAt: string;
};

export type AgentFleetNodeResult = {
	nodeId: string;
	agentId: string;
	status: FleetNodeStatus;
	attempts: number;
	output?: unknown;
	error?: string;
};

export type AgentFleetRunRecord = {
	id: string;
	fleetId: string;
	projectId: string;
	status: FleetRunStatus;
	nodes: FleetTaskNode[];
	nodeResults: AgentFleetNodeResult[];
	createdAt: string;
	completedAt: string | null;
};

export type AgentFleetMessageRecord = {
	id: string;
	runId: string;
	fromAgentId: string;
	toAgentId: string;
	type: FleetMessageType;
	payload: unknown;
	createdAt: string;
};

export type AgentFleetFeedbackRecord = {
	id: string;
	fleetId: string;
	agentId: string;
	runId: string | null;
	evalRunId: string | null;
	rating: FleetFeedbackRating;
	comment: string | null;
	createdAt: string;
};

export type AgentFleetSpecializationProposal = {
	agentId: string;
	status: 'stable' | 'proposed';
	update: ApplyAgentFleetSpecializationPayload | null;
	downCount: number;
	upCount: number;
};
