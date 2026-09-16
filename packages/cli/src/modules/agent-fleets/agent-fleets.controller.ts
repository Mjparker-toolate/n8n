import {
	AddAgentFleetMemberDto,
	ApplyAgentFleetSpecializationDto,
	CreateAgentFleetDto,
	CreateAgentFleetFeedbackDto,
	CreateAgentFleetRunDto,
	SendAgentFleetMessageDto,
	UpdateAgentFleetMemberDto,
	type AgentFleetFeedbackRecord,
	type AgentFleetMessageRecord,
	type AgentFleetRecord,
	type AgentFleetRunRecord,
	type AgentFleetSpecializationProposal,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Delete, Get, Patch, Post, ProjectScope, RestController } from '@n8n/decorators';

import { AgentFleetsService } from './agent-fleets.service';

type ProjectParam = { projectId: string };
type FleetParam = ProjectParam & { fleetId: string };
type MemberParam = FleetParam & { agentId: string };
type RunParam = FleetParam & { runId: string };

/**
 * Opt-in fleet protocols over existing n8n agents. Routes reuse `agent:*`
 * scopes so the builder permission model does not grow a second resource.
 */
@RestController('/projects/:projectId/agent-fleets')
export class AgentFleetsController {
	constructor(private readonly service: AgentFleetsService) {}

	@Post('/')
	@ProjectScope('agent:create')
	async create(
		req: AuthenticatedRequest<ProjectParam>,
		_res: unknown,
		@Body payload: CreateAgentFleetDto,
	): Promise<AgentFleetRecord> {
		return await this.service.createFleet(req.params.projectId, payload);
	}

	@Get('/')
	@ProjectScope('agent:list')
	list(req: AuthenticatedRequest<ProjectParam>): AgentFleetRecord[] {
		return this.service.listFleets(req.params.projectId);
	}

	@Get('/:fleetId')
	@ProjectScope('agent:read')
	get(req: AuthenticatedRequest<FleetParam>): AgentFleetRecord {
		return this.service.getFleet(req.params.projectId, req.params.fleetId);
	}

	@Delete('/:fleetId')
	@ProjectScope('agent:delete')
	delete(req: AuthenticatedRequest<FleetParam>): { deleted: true } {
		this.service.deleteFleet(req.params.projectId, req.params.fleetId);
		return { deleted: true };
	}

	@Post('/:fleetId/members')
	@ProjectScope('agent:update')
	async addMember(
		req: AuthenticatedRequest<FleetParam>,
		_res: unknown,
		@Body payload: AddAgentFleetMemberDto,
	): Promise<AgentFleetRecord> {
		return await this.service.addMember(req.params.projectId, req.params.fleetId, payload);
	}

	@Patch('/:fleetId/members/:agentId')
	@ProjectScope('agent:update')
	updateMember(
		req: AuthenticatedRequest<MemberParam>,
		_res: unknown,
		@Body payload: UpdateAgentFleetMemberDto,
	): AgentFleetRecord {
		return this.service.updateMember(
			req.params.projectId,
			req.params.fleetId,
			req.params.agentId,
			payload,
		);
	}

	@Post('/:fleetId/runs')
	@ProjectScope('agent:execute')
	async startRun(
		req: AuthenticatedRequest<FleetParam>,
		_res: unknown,
		@Body payload: CreateAgentFleetRunDto,
	): Promise<AgentFleetRunRecord> {
		return await this.service.startRun(req.params.projectId, req.params.fleetId, payload);
	}

	@Get('/:fleetId/runs/:runId')
	@ProjectScope('agent:read')
	getRun(req: AuthenticatedRequest<RunParam>): AgentFleetRunRecord {
		return this.service.getRun(req.params.projectId, req.params.fleetId, req.params.runId);
	}

	@Post('/:fleetId/runs/:runId/cancel')
	@ProjectScope('agent:update')
	cancelRun(req: AuthenticatedRequest<RunParam>): AgentFleetRunRecord {
		return this.service.cancelRun(req.params.projectId, req.params.fleetId, req.params.runId);
	}

	@Get('/:fleetId/runs/:runId/messages')
	@ProjectScope('agent:read')
	listMessages(req: AuthenticatedRequest<RunParam>): AgentFleetMessageRecord[] {
		return this.service.listMessages(req.params.projectId, req.params.fleetId, req.params.runId);
	}

	@Post('/:fleetId/runs/:runId/messages')
	@ProjectScope('agent:execute')
	sendMessage(
		req: AuthenticatedRequest<RunParam>,
		_res: unknown,
		@Body payload: SendAgentFleetMessageDto,
	): AgentFleetMessageRecord {
		return this.service.sendMessage(
			req.params.projectId,
			req.params.fleetId,
			req.params.runId,
			payload,
		);
	}

	@Post('/:fleetId/feedback')
	@ProjectScope('agent:update')
	recordFeedback(
		req: AuthenticatedRequest<FleetParam>,
		_res: unknown,
		@Body payload: CreateAgentFleetFeedbackDto,
	): AgentFleetFeedbackRecord {
		return this.service.recordFeedback(req.params.projectId, req.params.fleetId, payload);
	}

	@Get('/:fleetId/specialization/:agentId')
	@ProjectScope('agent:read')
	proposeSpecialization(req: AuthenticatedRequest<MemberParam>): AgentFleetSpecializationProposal {
		return this.service.proposeSpecialization(
			req.params.projectId,
			req.params.fleetId,
			req.params.agentId,
		);
	}

	@Post('/:fleetId/specialization')
	@ProjectScope('agent:update')
	applySpecialization(
		req: AuthenticatedRequest<FleetParam>,
		_res: unknown,
		@Body payload: ApplyAgentFleetSpecializationDto,
	): AgentFleetRecord {
		return this.service.applySpecialization(req.params.projectId, req.params.fleetId, payload);
	}
}
