import { Service } from '@n8n/di';
import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { JsonValue } from 'n8n-workflow';

import type { AgentFleetsConfig } from './agent-fleets.config';
import type {
	FleetSpecialistRunRequest,
	FleetSpecialistRunResult,
	FleetSpecialistRunner,
} from './agent-fleet-runner';
import { EchoFleetSpecialistRunner } from './agent-fleet-runner';

export const CLAWHUB_TOOL_PREFIX = 'clawhub:';
export const CURSOR_CLOUD_TOOL_ID = 'cursor-cloud';

export type DelegatingFleetRoute =
	| { kind: 'echo' }
	| { kind: 'clawhub'; slug: string }
	| { kind: 'cursor-cloud' };

export type DelegatingFleetSpecialistPorts = {
	readSkill: (skillDir: string) => Promise<{ skillMd: string; scriptPath: string | null }>;
	runScript: (scriptPath: string, request: FleetSpecialistRunRequest) => Promise<JsonValue>;
	createCursorAgent: (request: FleetSpecialistRunRequest) => Promise<JsonValue>;
};

const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

export function selectDelegatingRoute(tools: string[]): DelegatingFleetRoute {
	for (const tool of tools) {
		if (tool === CURSOR_CLOUD_TOOL_ID) {
			return { kind: 'cursor-cloud' };
		}
		if (tool.startsWith(CLAWHUB_TOOL_PREFIX)) {
			return { kind: 'clawhub', slug: tool.slice(CLAWHUB_TOOL_PREFIX.length) };
		}
	}
	return { kind: 'echo' };
}

export function resolveClawhubSkillsDir(
	config: Pick<AgentFleetsConfig, 'clawhubSkillsDir'>,
): string {
	const configured = config.clawhubSkillsDir.trim();
	if (configured.length > 0) return configured;
	return join(homedir(), '.cursor', 'skills');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Opt-in specialist runner. Default config still uses echo. Delegate mode
 * routes by fleet member tool ids and does not add a second n8n runtime.
 */
@Service()
export class DelegatingFleetSpecialistRunner implements FleetSpecialistRunner {
	private ports: DelegatingFleetSpecialistPorts;

	constructor(
		private readonly echoRunner: EchoFleetSpecialistRunner,
		private readonly config: AgentFleetsConfig,
	) {
		this.ports = {
			readSkill: defaultReadSkill,
			runScript: defaultRunScript,
			createCursorAgent: async (request) =>
				await defaultCreateCursorAgent(request, this.config.cursorApiUrl),
		};
	}

	/** Tests replace filesystem and HTTP without changing the DI constructor. */
	withPorts(ports: DelegatingFleetSpecialistPorts): this {
		this.ports = ports;
		return this;
	}

	async run(request: FleetSpecialistRunRequest): Promise<FleetSpecialistRunResult> {
		if (this.config.runner !== 'delegate') {
			return await this.echoRunner.run(request);
		}

		if (request.signal.aborted) {
			return { status: 'failed', error: 'Cancelled' };
		}

		const route = selectDelegatingRoute(request.tools);
		switch (route.kind) {
			case 'echo':
				return await this.echoRunner.run(request);
			case 'clawhub':
				return await this.runClawhubSkill(route.slug, request);
			case 'cursor-cloud':
				return await this.runCursorCloud(request);
			default: {
				const exhaustive: never = route;
				return { status: 'failed', error: `Unsupported route: ${JSON.stringify(exhaustive)}` };
			}
		}
	}

	private async runClawhubSkill(
		slug: string,
		request: FleetSpecialistRunRequest,
	): Promise<FleetSpecialistRunResult> {
		if (!SLUG_PATTERN.test(slug)) {
			return { status: 'failed', error: `Invalid ClawHub slug: "${slug}"` };
		}

		try {
			const skillDir = join(resolveClawhubSkillsDir(this.config), slug);
			const skill = await this.ports.readSkill(skillDir);
			if (skill.scriptPath) {
				const output = await this.ports.runScript(skill.scriptPath, request);
				return { status: 'ok', output };
			}
			return {
				status: 'ok',
				output: {
					slug,
					hasScript: false,
					skillMd: skill.skillMd,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'ClawHub skill run failed';
			return { status: 'failed', error: message };
		}
	}

	private async runCursorCloud(
		request: FleetSpecialistRunRequest,
	): Promise<FleetSpecialistRunResult> {
		try {
			const output = await this.ports.createCursorAgent(request);
			return { status: 'ok', output };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Cursor cloud agent create failed';
			return { status: 'failed', error: message };
		}
	}
}

async function resolveSkillDir(skillDir: string): Promise<string> {
	const candidate = resolve(skillDir);
	const parent = resolve(join(candidate, '..'));
	const realParent = await realpath(parent);
	const realCandidate = await realpath(candidate);
	if (realCandidate !== realParent && !realCandidate.startsWith(realParent + sep)) {
		throw new Error('Skill path is outside the skills directory');
	}
	return realCandidate;
}

async function defaultReadSkill(
	skillDir: string,
): Promise<{ skillMd: string; scriptPath: string | null }> {
	const resolved = await resolveSkillDir(skillDir);
	const skillMd = await readFile(join(resolved, 'SKILL.md'), 'utf8');
	const candidates = [
		join(resolved, 'scripts', 'run.sh'),
		join(resolved, 'scripts', 'run.py'),
		join(resolved, 'scripts', 'run.js'),
	];
	for (const candidate of candidates) {
		try {
			await stat(candidate);
			return { skillMd, scriptPath: candidate };
		} catch {
			continue;
		}
	}
	return { skillMd, scriptPath: null };
}

async function defaultRunScript(
	scriptPath: string,
	request: FleetSpecialistRunRequest,
): Promise<JsonValue> {
	const command = scriptCommand(scriptPath);
	return await new Promise<JsonValue>((resolvePromise, reject) => {
		const child = spawn(command.file, command.args, {
			env: {
				...process.env,
				FLEET_INSTRUCTION: request.instruction,
				FLEET_NODE_ID: request.nodeId,
				FLEET_AGENT_ID: request.agentId,
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const onAbort = () => {
			child.kill('SIGTERM');
		};
		request.signal.addEventListener('abort', onAbort, { once: true });

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.stdin.write(request.instruction);
		child.stdin.end();
		child.on('error', (error) => {
			request.signal.removeEventListener('abort', onAbort);
			reject(error);
		});
		child.on('close', (code) => {
			request.signal.removeEventListener('abort', onAbort);
			if (code === 0) {
				resolvePromise({ exitCode: 0, stdout, stderr });
				return;
			}
			reject(new Error(stderr.trim() || `Skill script exited with code ${String(code)}`));
		});
	});
}

function scriptCommand(scriptPath: string): { file: string; args: string[] } {
	if (scriptPath.endsWith('.py')) {
		return { file: 'python3', args: [scriptPath] };
	}
	if (scriptPath.endsWith('.js')) {
		return { file: 'node', args: [scriptPath] };
	}
	return { file: scriptPath, args: [] };
}

async function defaultCreateCursorAgent(
	request: FleetSpecialistRunRequest,
	cursorApiUrl: string,
): Promise<JsonValue> {
	const apiKey = process.env.CURSOR_API_KEY;
	if (!apiKey) {
		throw new Error('CURSOR_API_KEY is not set');
	}
	const repository = process.env.N8N_AGENT_FLEETS_CURSOR_REPOSITORY;
	if (!repository) {
		throw new Error('N8N_AGENT_FLEETS_CURSOR_REPOSITORY is not set');
	}

	const response = await fetch(cursorApiUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			prompt: { text: request.instruction },
			source: {
				repository,
				ref: process.env.N8N_AGENT_FLEETS_CURSOR_REF || 'master',
			},
		}),
		signal: request.signal,
	});

	const raw: unknown = await response.json().catch(() => null);
	const errorText =
		isRecord(raw) && typeof raw.error === 'string' ? raw.error : response.statusText;
	if (!response.ok) {
		throw new Error(`Cursor cloud API returned ${String(response.status)}: ${errorText}`);
	}

	const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
	const status = isRecord(raw) && typeof raw.status === 'string' ? raw.status : 'created';
	return {
		id,
		status,
		nodeId: request.nodeId,
	};
}
