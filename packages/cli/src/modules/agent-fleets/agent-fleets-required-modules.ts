import type { ModuleRegistry } from '@n8n/backend-common';

import { NotFoundError } from '@/errors/response-errors/not-found.error';

const REQUIRED_MODULES = ['agents'] as const;

/**
 * Fleet protocols bind existing n8n agents. Those entities only exist while the
 * agents module is active.
 */
export function assertRequiredModulesActive(moduleRegistry: ModuleRegistry): void {
	const inactive = REQUIRED_MODULES.filter((name) => !moduleRegistry.isActive(name));
	if (inactive.length > 0) {
		throw new NotFoundError(
			`Agent fleets require these modules to be active: ${inactive.join(', ')}.`,
		);
	}
}
