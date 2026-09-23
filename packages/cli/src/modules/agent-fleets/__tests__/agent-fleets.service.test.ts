import type { FleetAgentSpec } from '@n8n/api-types';
import type { Logger, ModuleRegistry } from '@n8n/backend-common';
import { mock, type MockProxy } from 'vitest-mock-extended';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import type { AgentRepository } from '@/modules/agents/repositories/agent.repository';

import { DelegatingFleetSpecialistRunner } from '../agent-fleet-delegating-runner';
import { EchoFleetSpecialistRunner } from '../agent-fleet-runner';
import { AgentFleetStore } from '../agent-fleet-store';
import type { AgentFleetsConfig } from '../agent-fleets.config';
import { AgentFleetsService } from '../agent-fleets.service';

vi.mock('@/modules/agents/repositories/agent.repository', () => ({
	AgentRepository: class AgentRepository {},
}));

const PROJECT_ID = 'proj-1';

const coordinator: FleetAgentSpec = {
	agentId: 'coord-1',
	role: 'coordinator',
	specialization: 'Split and join work',
	tools: [],
	memoryScope: 'none',
	lifecycle: 'active',
};

const specialist: FleetAgentSpec = {
	agentId: 'spec-1',
	role: 'specialist',
	specialization: 'Search tickets',
	tools: ['search_tickets'],
	memoryScope: 'observational',
	lifecycle: 'active',
};

describe('AgentFleetsService', () => {
	let moduleRegistry: MockProxy<ModuleRegistry>;
	let agentRepository: MockProxy<AgentRepository>;
	let logger: MockProxy<Logger>;
	let service: AgentFleetsService;

	beforeEach(() => {
		moduleRegistry = mock<ModuleRegistry>();
		moduleRegistry.isActive.mockReturnValue(true);
		agentRepository = mock<AgentRepository>();
		agentRepository.findByIdsAndProjectId.mockImplementation(async (ids: string[]) =>
			ids.map((id) => ({ id, activeVersionId: 'v1' })),
		);
		logger = mock<Logger>();
		logger.scoped.mockReturnValue(logger);
		const config = {
			maxParallel: 10,
			runner: 'echo',
			clawhubSkillsDir: '',
			cursorApiUrl: 'https://api.cursor.com/v0/agents',
		} as AgentFleetsConfig;
		const echoRunner = new EchoFleetSpecialistRunner();
		service = new AgentFleetsService(
			moduleRegistry,
			agentRepository,
			logger,
			config,
			new AgentFleetStore(),
			echoRunner,
			new DelegatingFleetSpecialistRunner(echoRunner, config),
		);
	});

	it('creates a fleet of specialized agents that already exist in the project', async () => {
		const fleet = await service.createFleet(PROJECT_ID, {
			name: 'Support fleet',
			coordinatorAgentId: 'coord-1',
			members: [coordinator, specialist],
		});

		expect(fleet.coordinatorAgentId).toBe('coord-1');
		expect(fleet.members).toHaveLength(2);
		expect(agentRepository.findByIdsAndProjectId).toHaveBeenCalledWith(
			['coord-1', 'spec-1'],
			PROJECT_ID,
		);
	});

	it('rejects a fleet with two coordinators', async () => {
		await expect(
			service.createFleet(PROJECT_ID, {
				name: 'Broken',
				coordinatorAgentId: 'coord-1',
				members: [coordinator, { ...coordinator, agentId: 'coord-2' }],
			}),
		).rejects.toBeInstanceOf(BadRequestError);
	});

	it('rejects unknown agent ids', async () => {
		agentRepository.findByIdsAndProjectId.mockResolvedValue([
			{ id: 'coord-1', activeVersionId: 'v1' },
		]);

		await expect(
			service.createFleet(PROJECT_ID, {
				name: 'Support fleet',
				coordinatorAgentId: 'coord-1',
				members: [coordinator, specialist],
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('runs a fan-out graph over typed messages', async () => {
		const fleet = await service.createFleet(PROJECT_ID, {
			name: 'Support fleet',
			coordinatorAgentId: 'coord-1',
			members: [
				coordinator,
				specialist,
				{ ...specialist, agentId: 'spec-2', specialization: 'Write replies' },
			],
		});

		const run = await service.startRun(PROJECT_ID, fleet.id, {
			nodes: [
				{
					id: 'split',
					agentId: 'coord-1',
					kind: 'fan-out',
					instruction: 'Split tickets',
					dependsOn: [],
				},
				{
					id: 'a',
					agentId: 'spec-1',
					kind: 'task',
					instruction: 'Search',
					dependsOn: ['split'],
				},
				{
					id: 'b',
					agentId: 'spec-2',
					kind: 'task',
					instruction: 'Draft',
					dependsOn: ['split'],
				},
				{
					id: 'join',
					agentId: 'coord-1',
					kind: 'fan-in',
					instruction: 'Merge',
					dependsOn: ['a', 'b'],
				},
			],
		});

		expect(run.status).toBe('succeeded');
		const messages = service.listMessages(PROJECT_ID, fleet.id, run.id);
		expect(messages.some((message) => message.type === 'task.assign')).toBe(true);
		expect(messages.some((message) => message.type === 'task.result')).toBe(true);
		expect(messages.every((message) => message.fromAgentId !== message.toAgentId)).toBe(true);
	});

	it('records eval feedback and proposes a specialization update', async () => {
		const fleet = await service.createFleet(PROJECT_ID, {
			name: 'Support fleet',
			coordinatorAgentId: 'coord-1',
			members: [coordinator, specialist],
		});

		service.recordFeedback(PROJECT_ID, fleet.id, {
			agentId: 'spec-1',
			evalRunId: 'eval-1',
			rating: 'down',
			comment: 'Missed billing intent',
		});
		service.recordFeedback(PROJECT_ID, fleet.id, {
			agentId: 'spec-1',
			rating: 'down',
		});
		service.recordFeedback(PROJECT_ID, fleet.id, {
			agentId: 'spec-1',
			rating: 'down',
			comment: 'Missed billing intent',
		});

		const proposal = service.proposeSpecialization(PROJECT_ID, fleet.id, 'spec-1');
		expect(proposal.status).toBe('proposed');
		expect(proposal.update).not.toBeNull();
		if (!proposal.update) throw new Error('expected a specialization update');

		const updated = service.applySpecialization(PROJECT_ID, fleet.id, proposal.update);
		expect(updated.members.find((member) => member.agentId === 'spec-1')?.specialization).toContain(
			'Missed billing intent',
		);
	});

	it('returns not-found when the agents module is inactive', async () => {
		moduleRegistry.isActive.mockReturnValue(false);
		await expect(
			service.createFleet(PROJECT_ID, {
				name: 'Support fleet',
				coordinatorAgentId: 'coord-1',
				members: [coordinator, specialist],
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});
