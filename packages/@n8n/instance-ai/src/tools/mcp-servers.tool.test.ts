import { isZodSchema, zodToJsonSchema } from '@n8n/agents';
import { mock } from 'vitest-mock-extended';

import { executeTool } from '../__tests__/tool-test-utils';
import type { InstanceAiContext, InstanceAiMcpService, McpRegistryServerSummary } from '../types';
import { createMcpServersTool } from './mcp-servers.tool';

const notion: McpRegistryServerSummary = {
	slug: 'notion',
	title: 'Notion',
	description: 'Work with Notion pages and databases',
	credentialType: 'notionMcpOAuth2Api',
	tools: [{ name: 'create_page', title: 'Create page' }],
	isConnected: false,
};

const linear: McpRegistryServerSummary = {
	slug: 'linear',
	title: 'Linear',
	description: 'Track issues in Linear',
	credentialType: 'linearMcpOAuth2Api',
	tools: [{ name: 'create_issue' }],
	isConnected: true,
};

function makeContext(mcpService?: InstanceAiMcpService): InstanceAiContext {
	const context = mock<InstanceAiContext>();
	context.mcpService = mcpService;
	return context;
}

function makeService(
	servers: McpRegistryServerSummary[],
	overrides: Partial<InstanceAiMcpService> = {},
): InstanceAiMcpService {
	return {
		search: vi.fn().mockResolvedValue(servers),
		getServers: vi
			.fn()
			.mockImplementation((slugs: string[]) =>
				servers.filter((server) => slugs.includes(server.slug)),
			),
		listConnectedSlugs: vi
			.fn()
			.mockResolvedValue(
				new Set(servers.filter((server) => server.isConnected).map((server) => server.slug)),
			),
		...overrides,
	};
}

interface SearchOutput {
	results: McpRegistryServerSummary[];
	hint?: string;
}

interface ConnectOutput {
	connectedSlugs: string[];
	skipped?: boolean;
	unknownSlugs?: string[];
	message: string;
}

interface SuspendPayload {
	requestId: string;
	message: string;
	mcpConnectRequest: { servers: Array<{ serverSlug: string; title: string; tagline?: string }> };
}

function suspendingContext() {
	const suspend = vi.fn().mockResolvedValue(undefined);
	return { ctx: { resumeData: undefined, suspend }, suspend };
}

type JsonSchema = NonNullable<ReturnType<typeof zodToJsonSchema>>;

function inputJsonSchema(): JsonSchema {
	const { inputSchema } = createMcpServersTool(makeContext(makeService([])));
	if (!isZodSchema(inputSchema)) throw new Error('expected a Zod input schema');
	const jsonSchema = zodToJsonSchema(inputSchema);
	if (!jsonSchema) throw new Error('expected the input schema to convert');
	return jsonSchema;
}

function property(schema: JsonSchema, name: string): JsonSchema {
	const value = schema.properties?.[name];
	if (typeof value !== 'object') throw new Error(`expected an object schema for "${name}"`);
	return value;
}

describe('mcp-servers tool', () => {
	// The provider schema is the flattened union: Anthropic rejects a request whose
	// tool input_schema has no top-level `type`, which takes down every message, not
	// just the ones that reach for this tool.
	describe('input schema', () => {
		it('is a top-level object rather than a bare union', () => {
			const schema = inputJsonSchema();

			expect(schema.type).toBe('object');
			expect(schema.anyOf).toBeUndefined();
			expect(schema.oneOf).toBeUndefined();
		});

		it('offers both actions and every per-action field', () => {
			const schema = inputJsonSchema();

			expect(property(schema, 'action').enum).toEqual(['search', 'connect']);
			expect(Object.keys(schema.properties ?? {})).toEqual(
				expect.arrayContaining(['action', 'queries', 'serverSlugs', 'reason']),
			);
		});

		it('requires only the action, leaving the rest to the handler', () => {
			expect(inputJsonSchema().required).toEqual(['action']);
		});

		it('keeps the per-action guidance the model needs to pick an action', () => {
			const schema = inputJsonSchema();

			expect(property(schema, 'action').description).toContain(
				'Look for tools that cover a service',
			);
			expect(property(schema, 'action').description).toContain('connect one of these services');
			expect(property(schema, 'queries').description).toContain('"search"');
			expect(property(schema, 'serverSlugs').description).toContain('at most 3');
		});
	});

	describe('search', () => {
		it('passes the queries through and returns the host-annotated results', async () => {
			const mcpService = makeService([notion, linear]);
			const tool = createMcpServersTool(makeContext(mcpService));

			const output = await executeTool<SearchOutput>(tool, {
				action: 'search',
				queries: ['notion', 'linear'],
			});

			expect(mcpService.search).toHaveBeenCalledWith(['notion', 'linear']);
			expect(output.results).toEqual([notion, linear]);
		});

		it('returns no results when nothing matches', async () => {
			const tool = createMcpServersTool(makeContext(makeService([])));

			const output = await executeTool<SearchOutput>(tool, {
				action: 'search',
				queries: ['nothing-like-this'],
			});

			expect(output.results).toEqual([]);
		});

		it('points at the connect action while any result is unconnected', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion, linear])));

			const output = await executeTool<SearchOutput>(tool, {
				action: 'search',
				queries: ['notion'],
			});

			expect(output.hint).toContain('action: "connect"');
		});

		it('omits the hint when everything found is already connected', async () => {
			const tool = createMcpServersTool(makeContext(makeService([linear])));

			const output = await executeTool<SearchOutput>(tool, {
				action: 'search',
				queries: ['linear'],
			});

			expect(output.hint).toBeUndefined();
		});

		it('rejects an empty query list', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion])));

			await expect(executeTool(tool, { action: 'search', queries: [] })).rejects.toThrow();
		});

		// The flattened provider schema marks every per-action field optional, so the
		// handler is the only thing still enforcing them.
		it('rejects a search with no queries at all', async () => {
			const mcpService = makeService([notion]);
			const tool = createMcpServersTool(makeContext(mcpService));

			await expect(executeTool(tool, { action: 'search' })).rejects.toThrow();
			expect(mcpService.search).not.toHaveBeenCalled();
		});

		it('fails loudly when the host did not wire the MCP service', async () => {
			const tool = createMcpServersTool(makeContext(undefined));

			await expect(executeTool(tool, { action: 'search', queries: ['notion'] })).rejects.toThrow(
				'Tool connections are not available on this instance.',
			);
		});

		it('propagates registry failures', async () => {
			const mcpService = makeService([], {
				search: vi.fn().mockRejectedValue(new Error('registry unavailable')),
			});
			const tool = createMcpServersTool(makeContext(mcpService));

			await expect(executeTool(tool, { action: 'search', queries: ['notion'] })).rejects.toThrow(
				'registry unavailable',
			);
		});
	});

	describe('connect', () => {
		it('suspends with the unconnected servers and the reason', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion])));
			const { ctx, suspend } = suspendingContext();

			await executeTool(
				tool,
				{ action: 'connect', serverSlugs: ['notion'], reason: 'To read your Notion pages' },
				ctx,
			);

			const payload = suspend.mock.calls[0][0] as SuspendPayload;
			expect(payload.message).toBe('To read your Notion pages');
			expect(payload.requestId).toBeTruthy();
			expect(payload.mcpConnectRequest).toEqual({
				servers: [
					{
						serverSlug: 'notion',
						title: 'Notion',
						credentialType: 'notionMcpOAuth2Api',
						tagline: 'Work with Notion pages and databases',
					},
				],
			});
		});

		it('only offers the servers that are not connected yet', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion, linear])));
			const { ctx, suspend } = suspendingContext();

			await executeTool(
				tool,
				{ action: 'connect', serverSlugs: ['notion', 'linear'], reason: 'Because' },
				ctx,
			);

			const payload = suspend.mock.calls[0][0] as SuspendPayload;
			expect(payload.mcpConnectRequest.servers.map((s) => s.serverSlug)).toEqual(['notion']);
		});

		it('is a no-op when every requested server is already connected', async () => {
			const tool = createMcpServersTool(makeContext(makeService([linear])));
			const { ctx, suspend } = suspendingContext();

			const output = await executeTool<ConnectOutput>(
				tool,
				{ action: 'connect', serverSlugs: ['linear'], reason: 'Because' },
				ctx,
			);

			expect(suspend).not.toHaveBeenCalled();
			expect(output.connectedSlugs).toEqual(['linear']);
			expect(output.message).toContain('Already connected');
		});

		it('tells the agent to search first when no slug resolves', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion])));
			const { ctx, suspend } = suspendingContext();

			const output = await executeTool<ConnectOutput>(
				tool,
				{ action: 'connect', serverSlugs: ['made-up'], reason: 'Because' },
				ctx,
			);

			expect(suspend).not.toHaveBeenCalled();
			expect(output.unknownSlugs).toEqual(['made-up']);
			expect(output.message).toContain('action: "search"');
		});

		it('rejects more than three suggestions', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion])));

			await expect(
				executeTool(
					tool,
					{ action: 'connect', serverSlugs: ['a', 'b', 'c', 'd'], reason: 'Because' },
					suspendingContext().ctx,
				),
			).rejects.toThrow();
		});

		it('rejects a connect that omits the slugs or the reason', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion])));
			const { ctx, suspend } = suspendingContext();

			await expect(
				executeTool(tool, { action: 'connect', reason: 'Because' }, ctx),
			).rejects.toThrow();
			await expect(
				executeTool(tool, { action: 'connect', serverSlugs: ['notion'] }, ctx),
			).rejects.toThrow();
			expect(suspend).not.toHaveBeenCalled();
		});

		it('names an invented slug alongside the servers it did resolve', async () => {
			const tool = createMcpServersTool(makeContext(makeService([notion])));
			const { ctx, suspend } = suspendingContext();

			await executeTool(
				tool,
				{ action: 'connect', serverSlugs: ['notion', 'made-up'], reason: 'Because' },
				ctx,
			);

			const payload = suspend.mock.calls[0][0] as SuspendPayload;
			expect(payload.mcpConnectRequest.servers.map((s) => s.serverSlug)).toEqual(['notion']);
			expect(payload.message).toContain('made-up');
		});

		it('reports only the slugs the server confirms are connected', async () => {
			const mcpService = makeService([notion], {
				listConnectedSlugs: vi.fn().mockResolvedValue(new Set(['notion'])),
			});
			const tool = createMcpServersTool(makeContext(mcpService));

			const output = await executeTool<ConnectOutput>(
				tool,
				{ action: 'connect', serverSlugs: ['notion'], reason: 'Because' },
				{ resumeData: { approved: true, connectedSlugs: ['notion'] } },
			);

			expect(output.connectedSlugs).toEqual(['notion']);
			expect(output.message).toContain('search_tools');
			// The resume rebuilds the agent with the new server attached, so the
			// tools are reachable in this turn rather than the next one.
			expect(output.message).toContain('available now');
		});

		it('ignores a client claim the server cannot confirm', async () => {
			const mcpService = makeService([notion], {
				listConnectedSlugs: vi.fn().mockResolvedValue(new Set<string>()),
			});
			const tool = createMcpServersTool(makeContext(mcpService));

			const output = await executeTool<ConnectOutput>(
				tool,
				{ action: 'connect', serverSlugs: ['notion'], reason: 'Because' },
				{ resumeData: { approved: true, connectedSlugs: ['notion'] } },
			);

			expect(output.connectedSlugs).toEqual([]);
			expect(output.message).toContain('No connection was created');
		});

		it('reports a skip when the user dismissed the card', async () => {
			const mcpService = makeService([notion], {
				listConnectedSlugs: vi.fn().mockResolvedValue(new Set<string>()),
			});
			const tool = createMcpServersTool(makeContext(mcpService));

			const output = await executeTool<ConnectOutput>(
				tool,
				{ action: 'connect', serverSlugs: ['notion'], reason: 'Because' },
				{ resumeData: { approved: false } },
			);

			expect(output).toMatchObject({ connectedSlugs: [], skipped: true });
			expect(output.message).toContain('skipped');
		});

		it('still reports a connection made before the user skipped the rest', async () => {
			const mcpService = makeService([notion], {
				listConnectedSlugs: vi.fn().mockResolvedValue(new Set(['notion'])),
			});
			const tool = createMcpServersTool(makeContext(mcpService));

			const output = await executeTool<ConnectOutput>(
				tool,
				{ action: 'connect', serverSlugs: ['notion'], reason: 'Because' },
				{ resumeData: { approved: false, connectedSlugs: ['notion'] } },
			);

			expect(output.connectedSlugs).toEqual(['notion']);
		});

		it('does not credit the card for a server connected before it appeared', async () => {
			const mcpService = makeService([notion, linear], {
				listConnectedSlugs: vi.fn().mockResolvedValue(new Set(['linear'])),
			});
			const tool = createMcpServersTool(makeContext(mcpService));

			const output = await executeTool<ConnectOutput>(
				tool,
				{ action: 'connect', serverSlugs: ['notion', 'linear'], reason: 'Because' },
				{ resumeData: { approved: false, connectedSlugs: [] } },
			);

			expect(output).toMatchObject({ connectedSlugs: [], skipped: true });
		});
	});
});
