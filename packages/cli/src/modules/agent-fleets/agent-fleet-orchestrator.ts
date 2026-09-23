import type {
	AgentFleetMessageRecord,
	AgentFleetNodeResult,
	AgentFleetRecord,
	AgentFleetRunRecord,
	FleetAgentSpec,
	FleetTaskNode,
	FleetTaskNodeKind,
} from '@n8n/api-types';
import { sleep } from '@n8n/utils/sleep';

import { FleetProtocolError, inboundResultsForDeps } from './agent-fleet-messages';
import { nodeRetry, type FleetSpecialistRunner } from './agent-fleet-runner';

export type AgentFleetOrchestratorOptions = {
	maxParallel: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => string;
};

function assertNodeKind(kind: FleetTaskNodeKind): void {
	switch (kind) {
		case 'coordinator':
		case 'task':
		case 'fan-out':
		case 'fan-in':
			return;
		default: {
			const exhaustive: never = kind;
			throw new FleetProtocolError(`Unsupported task node kind: ${String(exhaustive)}`);
		}
	}
}

function memberById(fleet: AgentFleetRecord, agentId: string): FleetAgentSpec | undefined {
	return fleet.members.find((member) => member.agentId === agentId);
}

function hasCycle(nodes: FleetTaskNode[]): boolean {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const walk = (id: string): boolean => {
		if (visited.has(id)) return false;
		if (visiting.has(id)) return true;
		visiting.add(id);
		const node = byId.get(id);
		if (!node) return true;
		for (const dep of node.dependsOn) {
			if (walk(dep)) return true;
		}
		visiting.delete(id);
		visited.add(id);
		return false;
	};

	return nodes.some((node) => walk(node.id));
}

export function describeTaskGraphError(
	fleet: AgentFleetRecord,
	nodes: FleetTaskNode[],
): string | null {
	const ids = nodes.map((node) => node.id);
	if (new Set(ids).size !== ids.length) {
		return 'Each task node must have a unique id';
	}

	const byId = new Map(nodes.map((node) => [node.id, node]));
	const dependents = new Map<string, string[]>();
	for (const node of nodes) {
		dependents.set(node.id, []);
	}
	for (const node of nodes) {
		for (const dep of node.dependsOn) {
			if (!byId.has(dep)) {
				return `Node "${node.id}" depends on unknown node "${dep}"`;
			}
			dependents.get(dep)?.push(node.id);
		}
	}

	if (hasCycle(nodes)) {
		return 'The task graph contains a cycle';
	}

	for (const node of nodes) {
		assertNodeKind(node.kind);
		const member = memberById(fleet, node.agentId);
		if (!member) {
			return `Node "${node.id}" refers to agent "${node.agentId}", who is not a fleet member`;
		}
		if (member.lifecycle !== 'active') {
			return `Node "${node.id}" cannot run because agent "${node.agentId}" is ${member.lifecycle}`;
		}
		if (node.kind === 'fan-in' && node.dependsOn.length < 2) {
			return `Fan-in node "${node.id}" must depend on at least two nodes`;
		}
		if (node.kind === 'fan-out' && (dependents.get(node.id)?.length ?? 0) < 2) {
			return `Fan-out node "${node.id}" must have at least two dependent nodes`;
		}
	}

	return null;
}

export class AgentFleetOrchestrator {
	constructor(private readonly options: AgentFleetOrchestratorOptions) {}

	async execute(args: {
		fleet: AgentFleetRecord;
		run: AgentFleetRunRecord;
		runner: FleetSpecialistRunner;
		signal: AbortSignal;
		publish: (
			message: Omit<AgentFleetMessageRecord, 'id' | 'createdAt'>,
		) => AgentFleetMessageRecord;
		listMessages: () => AgentFleetMessageRecord[];
	}): Promise<AgentFleetRunRecord> {
		const graphError = describeTaskGraphError(args.fleet, args.run.nodes);
		if (graphError) throw new FleetProtocolError(graphError);

		const results = new Map<string, AgentFleetNodeResult>(
			args.run.nodeResults.map((result) => [result.nodeId, result]),
		);
		const maxParallel = Math.max(1, this.options.maxParallel);
		const wait = this.options.sleep ?? sleep;
		const now = this.options.now ?? (() => new Date().toISOString());

		const publish = (message: Omit<AgentFleetMessageRecord, 'id' | 'createdAt'>) => {
			// Coordinator nodes run in-process. Do not record a self-send; keep the
			// log as point-to-point traffic between distinct agents.
			if (message.fromAgentId === message.toAgentId) return;
			args.publish(message);
		};

		const pending = () =>
			args.run.nodes.filter((node) => {
				const status = results.get(node.id)?.status ?? 'pending';
				return status === 'pending';
			});

		const depsSucceeded = (node: FleetTaskNode) =>
			node.dependsOn.every((dep) => results.get(dep)?.status === 'succeeded');

		const runNode = async (node: FleetTaskNode) => {
			const retry = nodeRetry(node);
			results.set(node.id, {
				nodeId: node.id,
				agentId: node.agentId,
				status: 'running',
				attempts: 0,
			});

			for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
				if (args.signal.aborted) {
					results.set(node.id, {
						nodeId: node.id,
						agentId: node.agentId,
						status: 'cancelled',
						attempts: attempt - 1,
						error: 'Cancelled',
					});
					publish({
						runId: args.run.id,
						fromAgentId: args.fleet.coordinatorAgentId,
						toAgentId: node.agentId,
						type: 'task.cancel',
						payload: { nodeId: node.id },
					});
					return;
				}

				publish({
					runId: args.run.id,
					fromAgentId: args.fleet.coordinatorAgentId,
					toAgentId: node.agentId,
					type: 'task.assign',
					payload: { nodeId: node.id, instruction: node.instruction, attempt },
				});

				const inbound = inboundResultsForDeps(args.listMessages(), node.dependsOn, node.agentId);
				const member = memberById(args.fleet, node.agentId);

				try {
					const result = await args.runner.run({
						agentId: node.agentId,
						nodeId: node.id,
						instruction: node.instruction,
						inboundMessages: inbound,
						signal: args.signal,
						tools: member?.tools ?? [],
					});

					if (result.status === 'ok') {
						results.set(node.id, {
							nodeId: node.id,
							agentId: node.agentId,
							status: 'succeeded',
							attempts: attempt,
							output: result.output,
						});
						for (const dependent of args.run.nodes.filter((item) =>
							item.dependsOn.includes(node.id),
						)) {
							publish({
								runId: args.run.id,
								fromAgentId: node.agentId,
								toAgentId: dependent.agentId,
								type: 'task.result',
								payload: {
									nodeId: node.id,
									output: result.output,
								},
							});
						}
						return;
					}

					if (attempt < retry.maxAttempts) {
						await wait(retry.backoffMs);
						continue;
					}

					results.set(node.id, {
						nodeId: node.id,
						agentId: node.agentId,
						status: 'failed',
						attempts: attempt,
						error: result.error,
					});
					publish({
						runId: args.run.id,
						fromAgentId: node.agentId,
						toAgentId: args.fleet.coordinatorAgentId,
						type: 'task.fail',
						payload: { nodeId: node.id, error: result.error },
					});
					return;
				} catch (error) {
					if (args.signal.aborted) {
						results.set(node.id, {
							nodeId: node.id,
							agentId: node.agentId,
							status: 'cancelled',
							attempts: attempt,
							error: 'Cancelled',
						});
						return;
					}
					const message = error instanceof Error ? error.message : 'Specialist run failed';
					if (attempt < retry.maxAttempts) {
						await wait(retry.backoffMs);
						continue;
					}
					results.set(node.id, {
						nodeId: node.id,
						agentId: node.agentId,
						status: 'failed',
						attempts: attempt,
						error: message,
					});
					publish({
						runId: args.run.id,
						fromAgentId: node.agentId,
						toAgentId: args.fleet.coordinatorAgentId,
						type: 'task.fail',
						payload: { nodeId: node.id, error: message },
					});
					return;
				}
			}
		};

		while (!args.signal.aborted) {
			const ready = pending().filter(depsSucceeded);
			if (ready.length === 0) break;
			const batch = ready.slice(0, maxParallel);
			await Promise.all(batch.map(async (node) => await runNode(node)));
		}

		if (args.signal.aborted) {
			for (const node of pending()) {
				results.set(node.id, {
					nodeId: node.id,
					agentId: node.agentId,
					status: 'cancelled',
					attempts: results.get(node.id)?.attempts ?? 0,
					error: 'Cancelled',
				});
				publish({
					runId: args.run.id,
					fromAgentId: args.fleet.coordinatorAgentId,
					toAgentId: node.agentId,
					type: 'task.cancel',
					payload: { nodeId: node.id },
				});
			}
		}

		const nodeResults = args.run.nodes.map(
			(node) =>
				results.get(node.id) ?? {
					nodeId: node.id,
					agentId: node.agentId,
					status: 'pending' as const,
					attempts: 0,
				},
		);

		const cancelled =
			args.signal.aborted || nodeResults.some((item) => item.status === 'cancelled');
		const failed = nodeResults.some((item) => item.status === 'failed');
		const status = cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';

		return {
			...args.run,
			status,
			nodeResults,
			completedAt: now(),
		};
	}
}
