import type { AgentFleetMessageRecord, FleetTaskNode } from '@n8n/api-types';
import { Service } from '@n8n/di';
import type { JsonValue } from 'n8n-workflow';

export type FleetSpecialistRunRequest = {
	agentId: string;
	nodeId: string;
	instruction: string;
	inboundMessages: AgentFleetMessageRecord[];
	signal: AbortSignal;
};

export type FleetSpecialistRunResult =
	| { status: 'ok'; output: JsonValue }
	| { status: 'failed'; error: string };

export interface FleetSpecialistRunner {
	run(request: FleetSpecialistRunRequest): Promise<FleetSpecialistRunResult>;
}

/**
 * Default runner for the opt-in protocol. It does not call a model. Live
 * specialist work stays on the agents module (`SubAgentSpawnRequest`).
 */
@Service()
export class EchoFleetSpecialistRunner implements FleetSpecialistRunner {
	async run(request: FleetSpecialistRunRequest): Promise<FleetSpecialistRunResult> {
		if (request.signal.aborted) {
			return { status: 'failed', error: 'Cancelled' };
		}

		return {
			status: 'ok',
			output: {
				nodeId: request.nodeId,
				instruction: request.instruction,
				inbound: request.inboundMessages.length,
			},
		};
	}
}

export function nodeRetry(node: FleetTaskNode): { maxAttempts: number; backoffMs: number } {
	return {
		maxAttempts: node.retry?.maxAttempts ?? 1,
		backoffMs: node.retry?.backoffMs ?? 0,
	};
}
