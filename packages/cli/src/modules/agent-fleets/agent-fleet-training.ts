import type {
	AgentFleetFeedbackRecord,
	AgentFleetRecord,
	AgentFleetSpecializationProposal,
	ApplyAgentFleetSpecializationPayload,
	FleetAgentSpec,
} from '@n8n/api-types';
import { FLEET_SPECIALIZATION_MAX_LENGTH } from '@n8n/api-types';

import { FleetProtocolError } from './agent-fleet-messages';

const DOWN_STREAK_TO_PROPOSE = 3;

export function applyMemberUpdate(
	member: FleetAgentSpec,
	update: Omit<ApplyAgentFleetSpecializationPayload, 'agentId'> & {
		lifecycle?: FleetAgentSpec['lifecycle'];
	},
): FleetAgentSpec {
	return {
		...member,
		specialization: update.specialization ?? member.specialization,
		tools: update.tools ?? member.tools,
		memoryScope: update.memoryScope ?? member.memoryScope,
		lifecycle: update.lifecycle ?? member.lifecycle,
	};
}

export function proposeSpecializationUpdate(
	fleet: AgentFleetRecord,
	agentId: string,
	feedback: AgentFleetFeedbackRecord[],
): AgentFleetSpecializationProposal {
	const member = fleet.members.find((item) => item.agentId === agentId);
	if (!member) {
		throw new FleetProtocolError(`Agent "${agentId}" is not a member of this fleet`);
	}

	const forAgent = feedback.filter((item) => item.agentId === agentId);
	const upCount = forAgent.filter((item) => item.rating === 'up').length;
	const downCount = forAgent.filter((item) => item.rating === 'down').length;
	const recent = forAgent.slice(-DOWN_STREAK_TO_PROPOSE);
	const downStreak =
		recent.length === DOWN_STREAK_TO_PROPOSE && recent.every((item) => item.rating === 'down');

	if (!downStreak) {
		return {
			agentId,
			status: 'stable',
			update: null,
			downCount,
			upCount,
		};
	}

	const latestDown = [...forAgent].reverse().find((item) => item.rating === 'down');
	const specialization = latestDown?.comment
		? `${member.specialization}. ${latestDown.comment}`
		: member.specialization;

	return {
		agentId,
		status: 'proposed',
		update: {
			agentId,
			specialization: specialization.slice(0, FLEET_SPECIALIZATION_MAX_LENGTH),
			tools: member.tools,
			memoryScope: member.memoryScope,
		},
		downCount,
		upCount,
	};
}
