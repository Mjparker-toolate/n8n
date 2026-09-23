import { Config, Env } from '@n8n/config';
import { z } from 'zod';

const fleetRunnerSchema = z.enum(['echo', 'delegate']);

export type AgentFleetRunnerMode = z.infer<typeof fleetRunnerSchema>;

@Config
export class AgentFleetsConfig {
	/**
	 * Maximum specialist nodes that one fleet run executes at the same time.
	 * @default 10
	 */
	@Env('N8N_AGENT_FLEETS_MAX_PARALLEL')
	maxParallel: number = 10;

	/**
	 * Specialist runner for fleet nodes. `echo` is the default protocol runner.
	 * `delegate` routes `clawhub:<slug>` and `cursor-cloud` tool ids.
	 */
	@Env('N8N_AGENT_FLEETS_RUNNER', fleetRunnerSchema)
	runner: AgentFleetRunnerMode = 'echo';

	/**
	 * Directory of installed ClawHub skills. Empty uses `~/.cursor/skills`.
	 */
	@Env('N8N_AGENT_FLEETS_CLAWHUB_SKILLS_DIR')
	clawhubSkillsDir: string = '';

	/**
	 * Cursor cloud agent create URL. Used only when the runner is `delegate`.
	 */
	@Env('N8N_AGENT_FLEETS_CURSOR_API_URL')
	cursorApiUrl: string = 'https://api.cursor.com/v0/agents';
}
