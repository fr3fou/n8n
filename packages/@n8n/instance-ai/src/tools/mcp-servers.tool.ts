/**
 * mcp-servers — discovery of the MCP registry, plus the inline card that connects
 * a server without leaving the conversation. Without `search` the agent never
 * learns a hosted MCP server exists for the service the user asked about and
 * falls back to nodes + credentials; without `connect` it can only recite the
 * manual steps.
 *
 * Everything the model reads here says "tools you can use in this conversation",
 * never "MCP"/"registry"/"server"/"card": it parrots these nouns back at the
 * user, and the scope wording is also what separates this from `credentials`,
 * which is about what a workflow node authenticates with at run time.
 */
import { Tool } from '@n8n/agents';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { sanitizeInputSchema } from '../agent/sanitize-mcp-schemas';
import type { InstanceAiContext, InstanceAiMcpService } from '../types';
import { DOMAIN_TOOL_IDS } from './tool-ids';

/** Beyond a shortlist the user is browsing, which the card's "Browse all tools"
 *  footer link covers. */
const MAX_SUGGESTED_SERVERS = 3;

const searchAction = z.object({
	action: z.literal('search').describe('Look for tools that cover a service.'),
	queries: z
		.array(z.string().min(1))
		.min(1)
		.describe(
			'Free-text queries matched against server name, title, and description — typically the service name (e.g. ["notion"], ["linear", "issue tracker"]).',
		),
});

const connectAction = z.object({
	action: z
		.literal('connect')
		.describe('Let the user connect one of these services from the conversation.'),
	serverSlugs: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_SUGGESTED_SERVERS)
		.describe(
			`Slugs returned by \`search\`, best match first, at most ${MAX_SUGGESTED_SERVERS}. Pass one unless the request genuinely matches several servers.`,
		),
	reason: z
		.string()
		.min(1)
		.describe('One short sentence for the confirmation record: what connecting unlocks.'),
});

const mcpServersRuntimeInputSchema = z.discriminatedUnion('action', [searchAction, connectAction]);

// A top-level union has no `type` in JSON Schema and Anthropic rejects the whole
// request ("input_schema.type: Field required"), so the provider gets a flattened
// object while the handler keeps parsing against the union for real narrowing and
// per-action validation.
const mcpServersToolInputSchema = sanitizeInputSchema(mcpServersRuntimeInputSchema);

const searchOutputSchema = z.object({
	results: z.array(
		z.object({
			slug: z.string(),
			title: z.string(),
			description: z.string(),
			tools: z.array(z.object({ name: z.string(), title: z.string().optional() })),
			isConnected: z.boolean(),
		}),
	),
	hint: z.string().optional(),
});

const connectOutputSchema = z.object({
	connectedSlugs: z.array(z.string()),
	skipped: z.boolean().optional(),
	unknownSlugs: z.array(z.string()).optional(),
	message: z.string(),
});

const mcpServersOutputSchema = z.union([searchOutputSchema, connectOutputSchema]);

const DESCRIPTION = `Find tools you can use in this conversation to work with a third-party service (e.g. Notion, Linear, Slack), and let the user connect one without leaving the chat.
Use \`search\` when the user asks for a service you have no connected tool for, before saying the integration is unavailable.
\`isConnected: true\` means its tools are already available to you, so do not offer to connect it again.
Use \`connect\` for a service that is not connected yet — it pauses until the user connects or skips. Only the user can complete a connection.`;

const CONNECT_HINT =
	'Not connected yet — call this tool again with `action: "connect"` and its slug so the user can connect it in place. Do not recite the manual steps instead.';

const suspendSchema = z.object({
	requestId: z.string(),
	message: z.string(),
	severity: z.literal('info'),
	mcpConnectRequest: z.object({
		servers: z.array(
			z.object({
				serverSlug: z.string(),
				title: z.string(),
				tagline: z.string().optional(),
			}),
		),
	}),
});

const resumeSchema = z.object({
	approved: z.boolean(),
	connectedSlugs: z.array(z.string()).optional(),
});

interface McpServersToolContext {
	resumeData: z.infer<typeof resumeSchema> | undefined;
	suspend: (payload: z.infer<typeof suspendSchema>) => Promise<never>;
}

function requireMcpService(context: InstanceAiContext): InstanceAiMcpService {
	const { mcpService } = context;
	if (!mcpService) throw new Error('Tool connections are not available on this instance.');
	return mcpService;
}

async function handleSearch(
	context: InstanceAiContext,
	input: z.infer<typeof searchAction>,
): Promise<z.infer<typeof searchOutputSchema>> {
	const results = await requireMcpService(context).search(input.queries);
	const anyUnconnected = results.some((result) => !result.isConnected);
	return { results, hint: anyUnconnected ? CONNECT_HINT : undefined };
}

async function handleConnect(
	context: InstanceAiContext,
	input: z.infer<typeof connectAction>,
	ctx: McpServersToolContext,
): Promise<z.infer<typeof connectOutputSchema>> {
	const mcpService = requireMcpService(context);
	const { resumeData } = ctx;

	if (resumeData !== undefined && resumeData !== null) {
		// The card reports which rows it connected, but only as a filter: intersecting
		// with the server's own view means a client can understate what happened,
		// never overstate it into tools the agent would then fail to call. Without a
		// report we fall back to every requested slug, which can include one that was
		// already connected before the card appeared.
		const connected = await mcpService.listConnectedSlugs();
		const claimed = resumeData.connectedSlugs;
		const candidates = claimed
			? input.serverSlugs.filter((slug) => claimed.includes(slug))
			: input.serverSlugs;
		const verified = candidates.filter((slug) => connected.has(slug));

		if (verified.length === 0) {
			return {
				connectedSlugs: [],
				skipped: !resumeData.approved,
				message: resumeData.approved
					? 'No connection was created. Continue without these tools and do not offer again.'
					: 'The user skipped connecting. Continue without these tools and do not ask again.',
			};
		}

		return {
			connectedSlugs: verified,
			message: `Connected: ${verified.join(', ')}. Their tools become available through \`search_tools\` from the next message onwards.`,
		};
	}

	const servers = await mcpService.getServers(input.serverSlugs);
	const known = new Set(servers.map((server) => server.slug));
	const unknownSlugs = input.serverSlugs.filter((slug) => !known.has(slug));

	if (servers.length === 0) {
		return {
			connectedSlugs: [],
			unknownSlugs,
			message: `No tool matches ${unknownSlugs.join(', ')}. Call \`action: "search"\` first and use a slug it returned.`,
		};
	}

	const unknownNote = unknownSlugs.length
		? ` No tool matches ${unknownSlugs.join(', ')} — only use slugs \`search\` returned.`
		: '';

	// One connection per server is a backend invariant, so re-offering a connected
	// one could only confuse the user.
	const alreadyConnected = servers.filter((server) => server.isConnected).map((s) => s.slug);
	const offerable = servers.filter((server) => !server.isConnected);

	if (offerable.length === 0) {
		return {
			connectedSlugs: alreadyConnected,
			...(unknownSlugs.length ? { unknownSlugs } : {}),
			message:
				`Already connected: ${alreadyConnected.join(', ')}. Look for their tools with \`search_tools\` and use them instead of offering a connection. ` +
				`If none show up, the connection needs re-authorising — ask the user to check it under "Connections".` +
				unknownNote,
		};
	}

	return await ctx.suspend({
		requestId: nanoid(),
		message: input.reason + unknownNote,
		severity: 'info',
		mcpConnectRequest: {
			servers: offerable.map((server) => ({
				serverSlug: server.slug,
				title: server.title,
				...(server.description ? { tagline: server.description } : {}),
			})),
		},
	});
}

export function createMcpServersTool(context: InstanceAiContext) {
	return new Tool(DOMAIN_TOOL_IDS.MCP_SERVERS)
		.description(DESCRIPTION)
		.input(mcpServersToolInputSchema)
		.output(mcpServersOutputSchema)
		.suspend(suspendSchema)
		.resume(resumeSchema)
		.handler(async (input, ctx: McpServersToolContext) => {
			const parsed = mcpServersRuntimeInputSchema.parse(input);
			return parsed.action === 'search'
				? await handleSearch(context, parsed)
				: await handleConnect(context, parsed, ctx);
		})
		.build();
}
