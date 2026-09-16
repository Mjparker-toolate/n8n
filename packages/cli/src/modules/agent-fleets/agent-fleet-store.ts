import type {
	AgentFleetFeedbackRecord,
	AgentFleetMessageRecord,
	AgentFleetRecord,
	AgentFleetRunRecord,
} from '@n8n/api-types';
import { Service } from '@n8n/di';

@Service()
export class AgentFleetStore {
	private readonly fleets = new Map<string, AgentFleetRecord>();
	private readonly runs = new Map<string, AgentFleetRunRecord>();
	private readonly messages = new Map<string, AgentFleetMessageRecord[]>();
	private readonly feedback = new Map<string, AgentFleetFeedbackRecord[]>();

	saveFleet(fleet: AgentFleetRecord): AgentFleetRecord {
		const copy = structuredClone(fleet);
		this.fleets.set(copy.id, copy);
		return structuredClone(copy);
	}

	getFleet(fleetId: string, projectId: string): AgentFleetRecord | null {
		const fleet = this.fleets.get(fleetId);
		if (!fleet || fleet.projectId !== projectId) return null;
		return structuredClone(fleet);
	}

	listFleets(projectId: string): AgentFleetRecord[] {
		return [...this.fleets.values()]
			.filter((fleet) => fleet.projectId === projectId)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map((fleet) => structuredClone(fleet));
	}

	deleteFleet(fleetId: string, projectId: string): boolean {
		const fleet = this.fleets.get(fleetId);
		if (!fleet || fleet.projectId !== projectId) return false;
		this.fleets.delete(fleetId);
		for (const [runId, run] of this.runs) {
			if (run.fleetId === fleetId) {
				this.runs.delete(runId);
				this.messages.delete(runId);
			}
		}
		this.feedback.delete(fleetId);
		return true;
	}

	saveRun(run: AgentFleetRunRecord): AgentFleetRunRecord {
		const copy = structuredClone(run);
		this.runs.set(copy.id, copy);
		return structuredClone(copy);
	}

	getRun(runId: string, fleetId: string, projectId: string): AgentFleetRunRecord | null {
		const run = this.runs.get(runId);
		if (!run || run.fleetId !== fleetId || run.projectId !== projectId) return null;
		return structuredClone(run);
	}

	appendMessage(message: AgentFleetMessageRecord): AgentFleetMessageRecord {
		const copy = structuredClone(message);
		const existing = this.messages.get(copy.runId) ?? [];
		existing.push(copy);
		this.messages.set(copy.runId, existing);
		return structuredClone(copy);
	}

	listMessages(runId: string): AgentFleetMessageRecord[] {
		return (this.messages.get(runId) ?? []).map((message) => structuredClone(message));
	}

	appendFeedback(record: AgentFleetFeedbackRecord): AgentFleetFeedbackRecord {
		const copy = structuredClone(record);
		const existing = this.feedback.get(copy.fleetId) ?? [];
		existing.push(copy);
		this.feedback.set(copy.fleetId, existing);
		return structuredClone(copy);
	}

	listFeedback(fleetId: string): AgentFleetFeedbackRecord[] {
		return (this.feedback.get(fleetId) ?? []).map((record) => structuredClone(record));
	}
}
