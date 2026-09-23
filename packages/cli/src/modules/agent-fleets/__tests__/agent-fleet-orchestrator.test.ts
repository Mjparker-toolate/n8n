import type { AgentFleetRecord, FleetTaskNode } from '@n8n/api-types';

import { inboundResultsForDeps } from '../agent-fleet-messages';
import { AgentFleetOrchestrator, describeTaskGraphError } from '../agent-fleet-orchestrator';
import type {
	FleetSpecialistRunner,
	FleetSpecialistRunRequest,
	FleetSpecialistRunResult,
} from '../agent-fleet-runner';
import { AgentFleetStore } from '../agent-fleet-store';

const PROJECT_ID = 'proj-1';

const coordinator = {
	agentId: 'coord-1',
	role: 'coordinator' as const,
	specialization: 'Split and join work',
	tools: [],
	memoryScope: 'none' as const,
	lifecycle: 'active' as const,
};

const specialistA = {
	agentId: 'spec-a',
	role: 'specialist' as const,
	specialization: 'Handle set A',
	tools: ['tool_a'],
	memoryScope: 'observational' as const,
	lifecycle: 'active' as const,
};

const specialistB = {
	agentId: 'spec-b',
	role: 'specialist' as const,
	specialization: 'Handle set B',
	tools: ['tool_b'],
	memoryScope: 'none' as const,
	lifecycle: 'active' as const,
};

function makeFleet(over: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
	return {
		id: 'fleet-1',
		projectId: PROJECT_ID,
		name: 'Support fleet',
		description: null,
		coordinatorAgentId: 'coord-1',
		members: [coordinator, specialistA, specialistB],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...over,
	};
}

function node(
	over: Pick<FleetTaskNode, 'id' | 'agentId' | 'kind' | 'instruction'> &
		Partial<Pick<FleetTaskNode, 'dependsOn' | 'retry'>>,
): FleetTaskNode {
	return {
		dependsOn: [],
		...over,
	};
}

function fanOutGraph(): FleetTaskNode[] {
	return [
		node({
			id: 'split',
			agentId: 'coord-1',
			kind: 'fan-out',
			instruction: 'Split the work',
		}),
		node({
			id: 'a',
			agentId: 'spec-a',
			kind: 'task',
			instruction: 'Do A',
			dependsOn: ['split'],
		}),
		node({
			id: 'b',
			agentId: 'spec-b',
			kind: 'task',
			instruction: 'Do B',
			dependsOn: ['split'],
		}),
		node({
			id: 'join',
			agentId: 'coord-1',
			kind: 'fan-in',
			instruction: 'Merge answers',
			dependsOn: ['a', 'b'],
		}),
	];
}

class ScriptedRunner implements FleetSpecialistRunner {
	readonly started: string[] = [];

	constructor(
		private readonly impl: (
			request: FleetSpecialistRunRequest,
		) => Promise<FleetSpecialistRunResult> | FleetSpecialistRunResult,
	) {}

	async run(request: FleetSpecialistRunRequest): Promise<FleetSpecialistRunResult> {
		this.started.push(request.nodeId);
		return await this.impl(request);
	}
}

async function execute(args: {
	fleet?: AgentFleetRecord;
	nodes: FleetTaskNode[];
	runner: FleetSpecialistRunner;
	signal?: AbortSignal;
	maxParallel?: number;
	sleep?: (ms: number) => Promise<void>;
}) {
	const fleet = args.fleet ?? makeFleet();
	const store = new AgentFleetStore();
	const run = store.saveRun({
		id: 'run-1',
		fleetId: fleet.id,
		projectId: fleet.projectId,
		status: 'running',
		nodes: args.nodes,
		nodeResults: args.nodes.map((item) => ({
			nodeId: item.id,
			agentId: item.agentId,
			status: 'pending',
			attempts: 0,
		})),
		createdAt: '2026-01-01T00:00:00.000Z',
		completedAt: null,
	});
	const orchestrator = new AgentFleetOrchestrator({
		maxParallel: args.maxParallel ?? 10,
		sleep: args.sleep ?? (async () => undefined),
		now: () => '2026-01-01T00:01:00.000Z',
	});
	const completed = await orchestrator.execute({
		fleet,
		run,
		runner: args.runner,
		signal: args.signal ?? new AbortController().signal,
		publish: (message) =>
			store.appendMessage({
				...message,
				id: `${message.type}-${Math.random()}`,
				createdAt: '2026-01-01T00:00:00.000Z',
			}),
		listMessages: () => store.listMessages(run.id),
	});
	return { completed, store };
}

describe('describeTaskGraphError', () => {
	it('rejects a cycle', () => {
		const error = describeTaskGraphError(makeFleet(), [
			node({ id: 'a', agentId: 'spec-a', kind: 'task', instruction: 'A', dependsOn: ['b'] }),
			node({ id: 'b', agentId: 'spec-b', kind: 'task', instruction: 'B', dependsOn: ['a'] }),
		]);
		expect(error).toBe('The task graph contains a cycle');
	});

	it('rejects a fan-in with one dependency', () => {
		const error = describeTaskGraphError(makeFleet(), [
			node({ id: 'a', agentId: 'spec-a', kind: 'task', instruction: 'A' }),
			node({
				id: 'join',
				agentId: 'coord-1',
				kind: 'fan-in',
				instruction: 'Join',
				dependsOn: ['a'],
			}),
		]);
		expect(error).toContain('at least two nodes');
	});

	it('rejects a draft specialist', () => {
		const fleet = makeFleet({
			members: [coordinator, { ...specialistA, lifecycle: 'draft' }, specialistB],
		});
		const error = describeTaskGraphError(fleet, [
			node({ id: 'a', agentId: 'spec-a', kind: 'task', instruction: 'A' }),
		]);
		expect(error).toContain('draft');
	});
});

describe('AgentFleetOrchestrator', () => {
	it('fans out sibling tasks and fans their results into the join node', async () => {
		const runner = new ScriptedRunner(async (request) => ({
			status: 'ok',
			output: { nodeId: request.nodeId, inbound: request.inboundMessages.length },
		}));

		const { completed, store } = await execute({ nodes: fanOutGraph(), runner });

		expect(completed.status).toBe('succeeded');
		expect(completed.nodeResults.map((item) => item.status)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded',
			'succeeded',
		]);
		expect(runner.started.slice(0, 1)).toEqual(['split']);
		expect(new Set(runner.started.slice(1, 3))).toEqual(new Set(['a', 'b']));
		expect(runner.started.at(-1)).toBe('join');

		const joinInbound = inboundResultsForDeps(store.listMessages('run-1'), ['a', 'b'], 'coord-1');
		expect(joinInbound).toHaveLength(2);
	});

	it('retries a failed specialist then succeeds', async () => {
		let attempts = 0;
		const runner = new ScriptedRunner(async () => {
			attempts += 1;
			if (attempts < 3) return { status: 'failed', error: 'transient' };
			return { status: 'ok', output: { ok: true } };
		});

		const { completed } = await execute({
			nodes: [
				node({
					id: 'a',
					agentId: 'spec-a',
					kind: 'task',
					instruction: 'Do A',
					retry: { maxAttempts: 3, backoffMs: 0 },
				}),
			],
			runner,
		});

		expect(completed.status).toBe('succeeded');
		expect(completed.nodeResults[0]?.attempts).toBe(3);
	});

	it('cancels nodes that have not started', async () => {
		const abort = new AbortController();
		const runner = new ScriptedRunner(async (request) => {
			if (request.nodeId === 'split') {
				abort.abort();
				return { status: 'ok', output: { ok: true } };
			}
			return { status: 'ok', output: { ok: true } };
		});

		const { completed } = await execute({
			nodes: fanOutGraph(),
			runner,
			signal: abort.signal,
		});

		expect(completed.status).toBe('cancelled');
		expect(completed.nodeResults.some((item) => item.status === 'cancelled')).toBe(true);
	});

	it('does not use a shared mutable blackboard as the result channel', async () => {
		const runner = new ScriptedRunner(async (request) => ({
			status: 'ok',
			output: { nodeId: request.nodeId },
		}));
		const { store } = await execute({ nodes: fanOutGraph(), runner });
		const messages = store.listMessages('run-1');
		expect(messages.every((message) => message.fromAgentId !== message.toAgentId)).toBe(true);
		expect(messages.some((message) => message.type === 'task.assign')).toBe(true);
		expect(messages.some((message) => message.type === 'task.result')).toBe(true);
	});

	it('passes fleet member tool ids into the specialist runner', async () => {
		const received: string[][] = [];
		const runner = new ScriptedRunner(async (runRequest) => {
			received.push(runRequest.tools);
			return { status: 'ok', output: { nodeId: runRequest.nodeId } };
		});

		await execute({
			nodes: [node({ id: 'a', agentId: 'spec-a', kind: 'task', instruction: 'Do A' })],
			runner,
		});

		expect(received).toEqual([['tool_a']]);
	});
});
