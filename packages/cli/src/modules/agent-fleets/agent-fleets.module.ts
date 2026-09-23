import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Opt-in fleet protocols over existing n8n agents. Enable with
 * N8N_ENABLED_MODULES=agent-fleets. The module is not a default, so the
 * common-case builder does not load it.
 */
@BackendModule({ name: 'agent-fleets', instanceTypes: ['main'] })
export class AgentFleetsModule implements ModuleInterface {
	async init() {
		await import('./agent-fleets.controller.js');

		const { AgentFleetsService } = await import('./agent-fleets.service.js');
		Container.get(AgentFleetsService);
	}

	async settings() {
		return { enabled: true };
	}
}
