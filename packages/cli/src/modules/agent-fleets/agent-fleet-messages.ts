import type { AgentFleetMessageRecord, FleetMessageType } from '@n8n/api-types';
import type { JsonValue } from 'n8n-workflow';

export class FleetProtocolError extends Error {
	readonly name = 'FleetProtocolError';

	constructor(message: string) {
		super(message);
	}
}

export type FleetNodePayload = {
	nodeId: string;
	instruction?: string;
	output?: JsonValue;
	error?: string;
	attempt?: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFleetNodePayload(value: unknown): value is FleetNodePayload {
	return isRecord(value) && typeof value.nodeId === 'string' && value.nodeId.length > 0;
}

export function inboundResultsForDeps(
	messages: AgentFleetMessageRecord[],
	dependsOn: string[],
	toAgentId: string,
): AgentFleetMessageRecord[] {
	const deps = new Set(dependsOn);
	return messages.filter((message) => {
		if (message.toAgentId !== toAgentId) return false;
		if (message.type !== 'task.result') return false;
		return isFleetNodePayload(message.payload) && deps.has(message.payload.nodeId);
	});
}

export function assertKnownMessageType(type: FleetMessageType): void {
	switch (type) {
		case 'task.assign':
		case 'task.result':
		case 'task.fail':
		case 'task.cancel':
		case 'coordination.ask':
		case 'coordination.reply':
			return;
		default: {
			const exhaustive: never = type;
			throw new FleetProtocolError(`Unsupported fleet message type: ${String(exhaustive)}`);
		}
	}
}
