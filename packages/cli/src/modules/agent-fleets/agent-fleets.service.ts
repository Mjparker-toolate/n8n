import type {
	AddAgentFleetMemberDto,
	AgentFleetFeedbackRecord,
	AgentFleetMessageRecord,
	AgentFleetRecord,
	AgentFleetRunRecord,
	AgentFleetSpecializationProposal,
	ApplyAgentFleetSpecializationPayload,
	CreateAgentFleetFeedbackPayload,
	CreateAgentFleetPayload,
	CreateAgentFleetRunPayload,
	FleetAgentSpec,
	SendAgentFleetMessagePayload,
	UpdateAgentFleetMemberDto,
} from '@n8n/api-types';
import { Logger, ModuleRegistry } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { randomUUID } from 'node:crypto';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { AgentRepository } from '@/modules/agents/repositories/agent.repository';

import { DelegatingFleetSpecialistRunner } from './agent-fleet-delegating-runner';
import { assertKnownMessageType, FleetProtocolError } from './agent-fleet-messages';
import { AgentFleetOrchestrator, describeTaskGraphError } from './agent-fleet-orchestrator';
import { EchoFleetSpecialistRunner, type FleetSpecialistRunner } from './agent-fleet-runner';
import { AgentFleetStore } from './agent-fleet-store';
import { applyMemberUpdate, proposeSpecializationUpdate } from './agent-fleet-training';
import { AgentFleetsConfig } from './agent-fleets.config';
import { assertRequiredModulesActive } from './agent-fleets-required-modules';

@Service()
export class AgentFleetsService {
	private readonly abortControllers = new Map<string, AbortController>();

	constructor(
		private readonly moduleRegistry: ModuleRegistry,
		private readonly agentRepository: AgentRepository,
		private readonly logger: Logger,
		private readonly config: AgentFleetsConfig,
		private readonly store: AgentFleetStore,
		private readonly echoRunner: EchoFleetSpecialistRunner,
		private readonly delegatingRunner: DelegatingFleetSpecialistRunner,
	) {
		this.logger = this.logger.scoped('agent-fleets');
	}

	async createFleet(
		projectId: string,
		payload: CreateAgentFleetPayload,
	): Promise<AgentFleetRecord> {
		this.assertAgentsModule();
		this.assertMemberList(payload.members, payload.coordinatorAgentId);
		await this.assertAgentsInProject(
			payload.members.map((member) => member.agentId),
			projectId,
		);

		const timestamp = new Date().toISOString();
		const fleet = this.store.saveFleet({
			id: randomUUID(),
			projectId,
			name: payload.name,
			description: payload.description ?? null,
			coordinatorAgentId: payload.coordinatorAgentId,
			members: payload.members,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		this.logger.debug('Created agent fleet', { fleetId: fleet.id, projectId });
		return fleet;
	}

	listFleets(projectId: string): AgentFleetRecord[] {
		this.assertAgentsModule();
		return this.store.listFleets(projectId);
	}

	getFleet(projectId: string, fleetId: string): AgentFleetRecord {
		this.assertAgentsModule();
		return this.requireFleet(fleetId, projectId);
	}

	deleteFleet(projectId: string, fleetId: string): void {
		this.assertAgentsModule();
		this.requireFleet(fleetId, projectId);
		this.store.deleteFleet(fleetId, projectId);
	}

	async addMember(
		projectId: string,
		fleetId: string,
		spec: AddAgentFleetMemberDto,
	): Promise<AgentFleetRecord> {
		this.assertAgentsModule();
		const fleet = this.requireFleet(fleetId, projectId);
		if (spec.role === 'coordinator') {
			throw new BadRequestError('A fleet already has a coordinator. Add a specialist instead.');
		}
		if (fleet.members.some((member) => member.agentId === spec.agentId)) {
			throw new BadRequestError(`Agent "${spec.agentId}" is already a member of this fleet`);
		}
		await this.assertAgentsInProject([spec.agentId], projectId);
		fleet.members.push(spec);
		fleet.updatedAt = new Date().toISOString();
		return this.store.saveFleet(fleet);
	}

	updateMember(
		projectId: string,
		fleetId: string,
		agentId: string,
		update: UpdateAgentFleetMemberDto,
	): AgentFleetRecord {
		this.assertAgentsModule();
		const fleet = this.requireFleet(fleetId, projectId);
		const index = fleet.members.findIndex((member) => member.agentId === agentId);
		if (index === -1) {
			throw new NotFoundError(`Agent "${agentId}" is not a member of this fleet`);
		}
		const member = fleet.members[index];
		if (member.role === 'coordinator' && update.lifecycle === 'retired') {
			throw new BadRequestError('Retire the fleet instead of retiring the coordinator');
		}
		fleet.members[index] = applyMemberUpdate(member, update);
		fleet.updatedAt = new Date().toISOString();
		return this.store.saveFleet(fleet);
	}

	async startRun(
		projectId: string,
		fleetId: string,
		payload: CreateAgentFleetRunPayload,
		runner: FleetSpecialistRunner = this.resolveRunner(),
	): Promise<AgentFleetRunRecord> {
		this.assertAgentsModule();
		const fleet = this.requireFleet(fleetId, projectId);
		const graphError = describeTaskGraphError(fleet, payload.nodes);
		if (graphError) throw new BadRequestError(graphError);

		const timestamp = new Date().toISOString();
		const run: AgentFleetRunRecord = {
			id: randomUUID(),
			fleetId,
			projectId,
			status: 'running',
			nodes: payload.nodes,
			nodeResults: payload.nodes.map((node) => ({
				nodeId: node.id,
				agentId: node.agentId,
				status: 'pending',
				attempts: 0,
			})),
			createdAt: timestamp,
			completedAt: null,
		};
		this.store.saveRun(run);

		const abort = new AbortController();
		this.abortControllers.set(run.id, abort);

		try {
			const orchestrator = new AgentFleetOrchestrator({
				maxParallel: this.config.maxParallel,
			});
			const completed = await orchestrator.execute({
				fleet,
				run,
				runner,
				signal: abort.signal,
				publish: (message) => this.persistMessage(message),
				listMessages: () => this.store.listMessages(run.id),
			});
			this.logger.debug('Finished agent fleet run', {
				fleetId,
				runId: completed.id,
				status: completed.status,
			});
			return this.store.saveRun(completed);
		} catch (error) {
			if (error instanceof FleetProtocolError) {
				throw new BadRequestError(error.message);
			}
			throw error;
		} finally {
			this.abortControllers.delete(run.id);
		}
	}

	getRun(projectId: string, fleetId: string, runId: string): AgentFleetRunRecord {
		this.assertAgentsModule();
		this.requireFleet(fleetId, projectId);
		const run = this.store.getRun(runId, fleetId, projectId);
		if (!run) throw new NotFoundError(`Fleet run "${runId}" was not found`);
		return run;
	}

	cancelRun(projectId: string, fleetId: string, runId: string): AgentFleetRunRecord {
		this.assertAgentsModule();
		const run = this.getRun(projectId, fleetId, runId);
		if (run.status !== 'running') {
			throw new BadRequestError(`Fleet run "${runId}" is ${run.status} and cannot be cancelled`);
		}
		const abort = this.abortControllers.get(runId);
		abort?.abort();
		if (!abort) {
			run.status = 'cancelled';
			run.completedAt = new Date().toISOString();
			return this.store.saveRun(run);
		}
		const latest = this.store.getRun(runId, fleetId, projectId);
		if (!latest) throw new NotFoundError(`Fleet run "${runId}" was not found`);
		return latest;
	}

	listMessages(projectId: string, fleetId: string, runId: string): AgentFleetMessageRecord[] {
		this.getRun(projectId, fleetId, runId);
		return this.store.listMessages(runId);
	}

	sendMessage(
		projectId: string,
		fleetId: string,
		runId: string,
		payload: SendAgentFleetMessagePayload,
	): AgentFleetMessageRecord {
		const fleet = this.requireFleet(fleetId, projectId);
		const run = this.getRun(projectId, fleetId, runId);
		assertKnownMessageType(payload.type);
		if (payload.fromAgentId === payload.toAgentId) {
			throw new BadRequestError('A fleet message must have different from and to agents');
		}
		this.assertMember(fleet, payload.fromAgentId);
		this.assertMember(fleet, payload.toAgentId);
		if (run.status !== 'running') {
			throw new BadRequestError(`Fleet run "${runId}" is ${run.status} and cannot accept messages`);
		}
		return this.persistMessage({
			runId,
			fromAgentId: payload.fromAgentId,
			toAgentId: payload.toAgentId,
			type: payload.type,
			payload: payload.payload,
		});
	}

	recordFeedback(
		projectId: string,
		fleetId: string,
		payload: CreateAgentFleetFeedbackPayload,
	): AgentFleetFeedbackRecord {
		const fleet = this.requireFleet(fleetId, projectId);
		this.assertMember(fleet, payload.agentId);
		if (payload.runId) {
			this.getRun(projectId, fleetId, payload.runId);
		}
		return this.store.appendFeedback({
			id: randomUUID(),
			fleetId,
			agentId: payload.agentId,
			runId: payload.runId ?? null,
			evalRunId: payload.evalRunId ?? null,
			rating: payload.rating,
			comment: payload.comment ?? null,
			createdAt: new Date().toISOString(),
		});
	}

	proposeSpecialization(
		projectId: string,
		fleetId: string,
		agentId: string,
	): AgentFleetSpecializationProposal {
		const fleet = this.requireFleet(fleetId, projectId);
		try {
			return proposeSpecializationUpdate(fleet, agentId, this.store.listFeedback(fleetId));
		} catch (error) {
			if (error instanceof FleetProtocolError) {
				throw new NotFoundError(error.message);
			}
			throw error;
		}
	}

	applySpecialization(
		projectId: string,
		fleetId: string,
		payload: ApplyAgentFleetSpecializationPayload,
	): AgentFleetRecord {
		if (
			payload.specialization === undefined &&
			payload.tools === undefined &&
			payload.memoryScope === undefined
		) {
			throw new BadRequestError(
				'A specialization update must include specialization, tools, or memoryScope',
			);
		}
		return this.updateMember(projectId, fleetId, payload.agentId, {
			specialization: payload.specialization,
			tools: payload.tools,
			memoryScope: payload.memoryScope,
		});
	}

	private resolveRunner(): FleetSpecialistRunner {
		return this.config.runner === 'delegate' ? this.delegatingRunner : this.echoRunner;
	}

	private persistMessage(
		message: Omit<AgentFleetMessageRecord, 'id' | 'createdAt'>,
	): AgentFleetMessageRecord {
		return this.store.appendMessage({
			...message,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
		});
	}

	private assertAgentsModule(): void {
		assertRequiredModulesActive(this.moduleRegistry);
	}

	private requireFleet(fleetId: string, projectId: string): AgentFleetRecord {
		const fleet = this.store.getFleet(fleetId, projectId);
		if (!fleet) throw new NotFoundError(`Agent fleet "${fleetId}" was not found`);
		return fleet;
	}

	private assertMember(fleet: AgentFleetRecord, agentId: string): FleetAgentSpec {
		const member = fleet.members.find((item) => item.agentId === agentId);
		if (!member) {
			throw new BadRequestError(`Agent "${agentId}" is not a member of this fleet`);
		}
		return member;
	}

	private assertMemberList(members: FleetAgentSpec[], coordinatorAgentId: string): void {
		const ids = members.map((member) => member.agentId);
		if (new Set(ids).size !== ids.length) {
			throw new BadRequestError('Each fleet member must have a unique agent id');
		}
		const coordinators = members.filter((member) => member.role === 'coordinator');
		if (coordinators.length !== 1) {
			throw new BadRequestError('A fleet must have exactly one coordinator');
		}
		if (coordinators[0].agentId !== coordinatorAgentId) {
			throw new BadRequestError('coordinatorAgentId must match the coordinator member');
		}
	}

	private async assertAgentsInProject(agentIds: string[], projectId: string): Promise<void> {
		const found = await this.agentRepository.findByIdsAndProjectId(agentIds, projectId);
		const foundIds = new Set(found.map((agent) => agent.id));
		const missing = agentIds.filter((id) => !foundIds.has(id));
		if (missing.length > 0) {
			throw new NotFoundError(`Agents not found in this project: ${missing.join(', ')}`);
		}
	}
}
