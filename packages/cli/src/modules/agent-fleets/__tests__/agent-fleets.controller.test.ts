import type { AuthenticatedRequest, User } from '@n8n/db';
import { ControllerRegistryMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { mock, type MockProxy } from 'vitest-mock-extended';

import type { AgentFleetsService } from '../agent-fleets.service';
import { AgentFleetsController } from '../agent-fleets.controller';

vi.mock('../agent-fleets.service', () => ({ AgentFleetsService: class AgentFleetsService {} }));

const PROJECT_ID = 'proj-1';
const FLEET_ID = 'fleet-1';

describe('AgentFleetsController', () => {
	const user = mock<User>({ id: 'user-1' });
	let service: MockProxy<AgentFleetsService>;
	let controller: AgentFleetsController;

	function makeReq<P extends Record<string, unknown>>(params: P): AuthenticatedRequest<P> {
		return { user, params, body: {} } as unknown as AuthenticatedRequest<P>;
	}

	beforeEach(() => {
		service = mock<AgentFleetsService>();
		controller = new AgentFleetsController(service);
	});

	describe('route access scopes', () => {
		const metadata = Container.get(ControllerRegistryMetadata).getControllerMetadata(
			AgentFleetsController as never,
		);
		const routeCases = Array.from(metadata.routes.entries()).map(([handlerName, route]) => ({
			handlerName,
			route,
		}));

		it('registers every handler', () => {
			expect(routeCases).not.toHaveLength(0);
		});

		it.each(routeCases)('$handlerName is gated by a project-scoped agent:* check', ({ route }) => {
			expect(route.accessScope).toBeDefined();
			expect(route.accessScope?.globalOnly).toBe(false);
			expect(route.accessScope?.scope.startsWith('agent:')).toBe(true);
		});
	});

	it('creates a fleet in the project', async () => {
		service.createFleet.mockResolvedValue({ id: FLEET_ID } as never);
		await controller.create(makeReq({ projectId: PROJECT_ID }), undefined, {
			name: 'Support fleet',
			coordinatorAgentId: 'coord-1',
			members: [],
		} as never);
		expect(service.createFleet).toHaveBeenCalledWith(PROJECT_ID, expect.any(Object));
	});
});
