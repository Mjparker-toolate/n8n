import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DelegatingFleetSpecialistRunner,
	selectDelegatingRoute,
} from '../agent-fleet-delegating-runner';
import { EchoFleetSpecialistRunner, type FleetSpecialistRunRequest } from '../agent-fleet-runner';
import type { AgentFleetsConfig } from '../agent-fleets.config';

function config(over: Partial<AgentFleetsConfig> = {}): AgentFleetsConfig {
	return {
		maxParallel: 10,
		runner: 'delegate',
		clawhubSkillsDir: '',
		cursorApiUrl: 'https://api.cursor.com/v0/agents',
		...over,
	} as AgentFleetsConfig;
}

function request(over: Partial<FleetSpecialistRunRequest> = {}): FleetSpecialistRunRequest {
	return {
		agentId: 'spec-1',
		nodeId: 'n1',
		instruction: 'Do the work',
		inboundMessages: [],
		signal: new AbortController().signal,
		tools: [],
		...over,
	};
}

describe('selectDelegatingRoute', () => {
	it('selects the first matching tool id', () => {
		expect(selectDelegatingRoute(['search', 'clawhub:demo', 'cursor-cloud'])).toEqual({
			kind: 'clawhub',
			slug: 'demo',
		});
		expect(selectDelegatingRoute(['cursor-cloud', 'clawhub:demo'])).toEqual({
			kind: 'cursor-cloud',
		});
		expect(selectDelegatingRoute(['search'])).toEqual({ kind: 'echo' });
	});
});

describe('DelegatingFleetSpecialistRunner', () => {
	it('stays on echo when the runner mode is echo', async () => {
		const echo = new EchoFleetSpecialistRunner();
		const runner = new DelegatingFleetSpecialistRunner(echo, config({ runner: 'echo' })).withPorts({
			readSkill: async () => {
				throw new Error('should not inspect');
			},
			runScript: async () => {
				throw new Error('should not run');
			},
			createCursorAgent: async () => {
				throw new Error('should not create');
			},
		});

		const result = await runner.run(request({ tools: ['clawhub:demo'] }));
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') throw new Error('expected echo output');
		expect(result.output).toMatchObject({ instruction: 'Do the work' });
	});

	it('inspects a ClawHub skill and runs its script', async () => {
		const echo = new EchoFleetSpecialistRunner();
		const runner = new DelegatingFleetSpecialistRunner(echo, config()).withPorts({
			readSkill: async () => ({ skillMd: '# Demo', scriptPath: '/tmp/run.sh' }),
			runScript: async (_scriptPath, runRequest) => ({
				ran: true,
				instruction: runRequest.instruction,
			}),
			createCursorAgent: async () => {
				throw new Error('should not create');
			},
		});

		const result = await runner.run(request({ tools: ['clawhub:demo'] }));
		expect(result).toEqual({
			status: 'ok',
			output: { ran: true, instruction: 'Do the work' },
		});
	});

	it('returns inspected skill text when no script exists', async () => {
		const skillsDir = await mkdtemp(join(tmpdir(), 'fleet-skills-'));
		await mkdir(join(skillsDir, 'demo'));
		await writeFile(join(skillsDir, 'demo', 'SKILL.md'), '---\nname: demo\n---\n# Demo\n');

		const echo = new EchoFleetSpecialistRunner();
		const runner = new DelegatingFleetSpecialistRunner(
			echo,
			config({ clawhubSkillsDir: skillsDir }),
		);

		const result = await runner.run(request({ tools: ['clawhub:demo'] }));
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') throw new Error('expected inspect output');
		expect(result.output).toMatchObject({ slug: 'demo', hasScript: false });
	});

	it('rejects an invalid ClawHub slug', async () => {
		const echo = new EchoFleetSpecialistRunner();
		const runner = new DelegatingFleetSpecialistRunner(echo, config());
		const result = await runner.run(request({ tools: ['clawhub:../etc'] }));
		expect(result.status).toBe('failed');
	});

	it('creates a Cursor cloud agent for the cursor-cloud tool id', async () => {
		const echo = new EchoFleetSpecialistRunner();
		const runner = new DelegatingFleetSpecialistRunner(echo, config()).withPorts({
			readSkill: async () => {
				throw new Error('should not inspect');
			},
			runScript: async () => {
				throw new Error('should not run');
			},
			createCursorAgent: async (runRequest) => ({
				id: 'bc-test',
				status: 'created',
				instruction: runRequest.instruction,
			}),
		});

		const result = await runner.run(request({ tools: ['cursor-cloud'] }));
		expect(result).toEqual({
			status: 'ok',
			output: { id: 'bc-test', status: 'created', instruction: 'Do the work' },
		});
	});
});
