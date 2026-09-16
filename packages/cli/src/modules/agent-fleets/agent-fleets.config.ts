import { Config, Env } from '@n8n/config';

@Config
export class AgentFleetsConfig {
	/**
	 * Maximum specialist nodes that one fleet run executes at the same time.
	 * @default 10
	 */
	@Env('N8N_AGENT_FLEETS_MAX_PARALLEL')
	maxParallel: number = 10;
}
