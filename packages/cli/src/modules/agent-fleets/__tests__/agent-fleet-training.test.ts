import type { AgentFleetFeedbackRecord, AgentFleetRecord } from '@n8n/api-types';

import { proposeSpecializationUpdate } from '../agent-fleet-training';

const fleet: AgentFleetRecord = {
	id: 'fleet-1',
	projectId: 'proj-1',
	name: 'Support fleet',
	description: null,
	coordinatorAgentId: 'coord-1',
	members: [
		{
			agentId: 'spec-a',
			role: 'specialist',
			specialization: 'Search tickets',
			tools: ['search_tickets'],
			memoryScope: 'observational',
			lifecycle: 'active',
		},
	],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

function feedback(
	over: Partial<AgentFleetFeedbackRecord> & Pick<AgentFleetFeedbackRecord, 'id' | 'rating'>,
): AgentFleetFeedbackRecord {
	return {
		fleetId: 'fleet-1',
		agentId: 'spec-a',
		runId: null,
		evalRunId: 'eval-1',
		comment: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		...over,
	};
}

describe('proposeSpecializationUpdate', () => {
	it('keeps the spec stable when ratings are mixed', () => {
		const proposal = proposeSpecializationUpdate(fleet, 'spec-a', [
			feedback({ id: '1', rating: 'down' }),
			feedback({ id: '2', rating: 'up' }),
			feedback({ id: '3', rating: 'down' }),
		]);
		expect(proposal.status).toBe('stable');
		expect(proposal.update).toBeNull();
	});

	it('proposes a specialization note after three down ratings', () => {
		const proposal = proposeSpecializationUpdate(fleet, 'spec-a', [
			feedback({ id: '1', rating: 'down', comment: 'Missed billing intent' }),
			feedback({ id: '2', rating: 'down' }),
			feedback({ id: '3', rating: 'down', comment: 'Missed billing intent' }),
		]);
		expect(proposal.status).toBe('proposed');
		expect(proposal.update?.specialization).toContain('Missed billing intent');
		expect(proposal.downCount).toBe(3);
	});
});
