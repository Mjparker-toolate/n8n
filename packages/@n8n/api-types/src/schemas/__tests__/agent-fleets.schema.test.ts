import {
	AddAgentFleetMemberDto,
	createAgentFleetSchema,
	CreateAgentFleetDto,
	CreateAgentFleetFeedbackDto,
	CreateAgentFleetRunDto,
	FLEET_MAX_GRAPH_NODES,
	FLEET_MAX_MEMBERS,
	fleetAgentSpecSchema,
	fleetMessageTypeSchema,
	fleetTaskNodeSchema,
	SendAgentFleetMessageDto,
} from '../agent-fleets.schema';

describe('fleetAgentSpecSchema', () => {
	const validSpec = {
		agentId: 'agent-1',
		role: 'specialist',
		specialization: 'Summarize support tickets',
		tools: ['search_tickets'],
		memoryScope: 'observational',
		lifecycle: 'active',
	};

	it('accepts a complete specialist spec', () => {
		expect(fleetAgentSpecSchema.safeParse(validSpec).success).toBe(true);
	});

	it('rejects an empty specialization', () => {
		expect(fleetAgentSpecSchema.safeParse({ ...validSpec, specialization: '' }).success).toBe(
			false,
		);
	});

	it('rejects an unknown memory scope', () => {
		expect(
			fleetAgentSpecSchema.safeParse({ ...validSpec, memoryScope: 'blackboard' }).success,
		).toBe(false);
	});
});

describe('CreateAgentFleetDto', () => {
	const payload = {
		name: 'Support fleet',
		coordinatorAgentId: 'coord-1',
		members: [
			{
				agentId: 'coord-1',
				role: 'coordinator',
				specialization: 'Split and join support work',
				tools: [],
				memoryScope: 'none',
				lifecycle: 'active',
			},
			{
				agentId: 'spec-1',
				role: 'specialist',
				specialization: 'Search tickets',
				tools: ['search_tickets'],
				memoryScope: 'observational',
				lifecycle: 'active',
			},
		],
	};

	it('accepts a coordinator plus one specialist', () => {
		expect(CreateAgentFleetDto.safeParse(payload).success).toBe(true);
	});

	it('rejects a fleet with no members', () => {
		expect(CreateAgentFleetDto.safeParse({ ...payload, members: [] }).success).toBe(false);
	});

	it('rejects a fleet that exceeds the member cap', () => {
		const members = Array.from({ length: FLEET_MAX_MEMBERS + 1 }, (_, index) => ({
			agentId: `agent-${index}`,
			role: 'specialist' as const,
			specialization: 'Work',
			tools: [],
			memoryScope: 'none' as const,
			lifecycle: 'active' as const,
		}));
		expect(createAgentFleetSchema.safeParse({ ...payload, members }).success).toBe(false);
	});
});

describe('AddAgentFleetMemberDto', () => {
	it('accepts a specialist member', () => {
		expect(
			AddAgentFleetMemberDto.safeParse({
				agentId: 'spec-2',
				role: 'specialist',
				specialization: 'Write replies',
				tools: ['draft_reply'],
				memoryScope: 'episodic',
				lifecycle: 'draft',
			}).success,
		).toBe(true);
	});
});

describe('fleetTaskNodeSchema', () => {
	it('defaults dependsOn to an empty list', () => {
		const parsed = fleetTaskNodeSchema.safeParse({
			id: 't1',
			agentId: 'spec-1',
			kind: 'task',
			instruction: 'Search open tickets',
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.dependsOn).toEqual([]);
		}
	});

	it('rejects a node id with spaces', () => {
		expect(
			fleetTaskNodeSchema.safeParse({
				id: 'bad id',
				agentId: 'spec-1',
				kind: 'task',
				instruction: 'Search',
			}).success,
		).toBe(false);
	});
});

describe('CreateAgentFleetRunDto', () => {
	it('accepts a fan-out graph', () => {
		expect(
			CreateAgentFleetRunDto.safeParse({
				nodes: [
					{
						id: 'split',
						agentId: 'coord-1',
						kind: 'fan-out',
						instruction: 'Split the tickets',
					},
					{
						id: 'a',
						agentId: 'spec-1',
						kind: 'task',
						instruction: 'Handle set A',
						dependsOn: ['split'],
					},
					{
						id: 'b',
						agentId: 'spec-2',
						kind: 'task',
						instruction: 'Handle set B',
						dependsOn: ['split'],
					},
					{
						id: 'join',
						agentId: 'coord-1',
						kind: 'fan-in',
						instruction: 'Merge the answers',
						dependsOn: ['a', 'b'],
					},
				],
			}).success,
		).toBe(true);
	});

	it('rejects a graph that exceeds the node cap', () => {
		const nodes = Array.from({ length: FLEET_MAX_GRAPH_NODES + 1 }, (_, index) => ({
			id: `n${index}`,
			agentId: 'spec-1',
			kind: 'task' as const,
			instruction: 'Work',
		}));
		expect(CreateAgentFleetRunDto.safeParse({ nodes }).success).toBe(false);
	});
});

describe('SendAgentFleetMessageDto', () => {
	it('accepts a typed point-to-point message', () => {
		expect(
			SendAgentFleetMessageDto.safeParse({
				fromAgentId: 'spec-1',
				toAgentId: 'coord-1',
				type: 'coordination.ask',
				payload: { question: 'Which queue?' },
			}).success,
		).toBe(true);
	});

	it('rejects an unknown message type', () => {
		expect(fleetMessageTypeSchema.safeParse('blackboard.write').success).toBe(false);
	});
});

describe('CreateAgentFleetFeedbackDto', () => {
	it('accepts a down rating with an eval run id', () => {
		expect(
			CreateAgentFleetFeedbackDto.safeParse({
				agentId: 'spec-1',
				evalRunId: 'eval-1',
				rating: 'down',
				comment: 'Missed the billing intent',
			}).success,
		).toBe(true);
	});
});
