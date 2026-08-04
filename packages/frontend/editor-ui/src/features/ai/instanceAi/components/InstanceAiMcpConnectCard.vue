<script lang="ts" setup>
/**
 * Inline "Available tools" card: the assistant found MCP registry servers for
 * something the user asked about and offers to connect one in place. Owns the
 * connect flow and the store reads; the transport of the resolution is the
 * caller's job (see `InstanceAiMcpConnect.vue`).
 */
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { InstanceAiMcpConnectServer, McpRegistryServerResponse } from '@n8n/api-types';
import { computed, ref, watch } from 'vue';
import { useUIStore } from '@/app/stores/ui.store';
import { INSTANCE_AI_TOOLS_CONNECTION_MODAL_KEY } from '@/app/constants/modals';
import { useInstanceAiMcpStore } from '../instanceAiMcp.store';
import { useInstanceAiMcpTelemetry } from '../instanceAiMcp.telemetry';
import { useMcpServerConnect } from '../composables/useMcpServerConnect';
import { connectionRowIcon } from '../toolIcons';
import ConfirmationFooter from './ConfirmationFooter.vue';
import ConnectionRow, {
	type ConnectionRowIcon,
	type ConnectionRowVariant,
} from './ConnectionRow.vue';

const props = defineProps<{
	servers: InstanceAiMcpConnectServer[];
	/** The card has settled: it stays in the transcript with no way left to resolve
	 *  it, but connected rows keep their live settings/disconnect actions. */
	readOnly?: boolean;
	/** The underlying confirmation is gone (TTL prune, restart, cancel). */
	expired?: boolean;
}>();

const emit = defineEmits<{
	resolve: [{ approved: boolean; connectedSlugs: string[] }];
}>();

const i18n = useI18n();
const uiStore = useUIStore();
const mcpStore = useInstanceAiMcpStore();
const mcpTelemetry = useInstanceAiMcpTelemetry();
const { connectServer } = useMcpServerConnect();

const connectingSlug = ref<string | null>(null);
const submitted = ref(false);

void mcpStore.fetchCatalogLazy();
void mcpStore.ensureConnectionsLoaded();

const catalogBySlug = computed(() => {
	const map = new Map<string, McpRegistryServerResponse>();
	for (const server of mcpStore.catalog ?? []) map.set(server.slug, server);
	return map;
});

interface CardRow {
	serverSlug: string;
	title: string;
	subtitle: string;
	icon: ConnectionRowIcon;
	credentialType?: string;
	connectionId?: string;
}

/**
 * The live registry entry wins over the payload snapshot — it carries the icon and
 * credential type. Connected state is read now rather than replayed, so a card can
 * show a server that was connected here and since removed as unconnected.
 */
const rows = computed<CardRow[]>(() =>
	props.servers.map((server) => {
		const entry = catalogBySlug.value.get(server.serverSlug);
		const connection = mcpStore.connections.find((c) => c.serverSlug === server.serverSlug);
		return {
			serverSlug: server.serverSlug,
			title: entry?.title ?? server.title,
			subtitle: entry?.tagline ?? server.tagline ?? '',
			icon: connectionRowIcon(entry?.icons ?? [], uiStore.appliedTheme),
			credentialType: entry?.credentialType ?? server.credentialType,
			connectionId: connection?.id,
		};
	}),
);

const isActionable = computed(() => !props.readOnly && !props.expired && !submitted.value);
const anyConnected = computed(() => rows.value.some((row) => row.connectionId));

function finish(approved: boolean) {
	if (submitted.value) return;
	submitted.value = true;
	emit('resolve', {
		approved,
		connectedSlugs: rows.value.filter((row) => row.connectionId).map((row) => row.serverSlug),
	});
}

// Also covers connecting from elsewhere — the tools modal this card links to, the
// sidebar, another tab. Without it a card whose rows all went connected somewhere
// else has nothing left to click and the run stays suspended.
watch(
	[isActionable, rows],
	([actionable, currentRows]) => {
		if (actionable && currentRows.every((row) => row.connectionId)) finish(true);
	},
	{ immediate: true },
);

/** Only a row we can actually start a credential flow for gets a Connect button. */
function rowVariant(row: CardRow): ConnectionRowVariant {
	return !row.connectionId && isActionable.value && row.credentialType ? 'connect' : 'status';
}

async function handleConnect(row: CardRow) {
	if (!isActionable.value || connectingSlug.value || !row.credentialType) return;

	connectingSlug.value = row.serverSlug;
	try {
		await connectServer({ slug: row.serverSlug, credentialType: row.credentialType });
	} finally {
		connectingSlug.value = null;
	}
}

function handleBrowseAll() {
	mcpTelemetry.trackToolsListOpened();
	uiStore.openModal(INSTANCE_AI_TOOLS_CONNECTION_MODAL_KEY);
}

function openSettings(row: CardRow) {
	if (!row.connectionId) return;
	mcpTelemetry.trackSettingsOpened(row.serverSlug);
	uiStore.openModalWithData({
		name: INSTANCE_AI_TOOLS_CONNECTION_MODAL_KEY,
		data: { connectionId: row.connectionId },
	});
}

async function handleDisconnect(row: CardRow) {
	if (row.connectionId) await mcpStore.disconnect(row.connectionId);
}
</script>

<template>
	<div
		:class="[$style.card, isActionable && $style.awaitingInput]"
		data-test-id="instance-ai-mcp-connect-card"
	>
		<header :class="$style.header">
			<N8nIcon icon="plug" size="medium" />
			<N8nText size="medium" color="text-dark" bold>
				{{
					i18n.baseText(
						expired ? 'instanceAi.mcpConnect.titleExpired' : 'instanceAi.mcpConnect.title',
					)
				}}
			</N8nText>
		</header>

		<div :class="$style.rows">
			<!-- A row the user skipped (or that settled read-only/expired) was never connected,
			     so it reports no status rather than a failure-coloured "Disconnected". -->
			<ConnectionRow
				v-for="row in rows"
				:key="row.serverSlug"
				:name="row.title"
				:subtitle="row.subtitle"
				:icon="row.icon"
				:status="row.connectionId ? 'connected' : 'none'"
				:actions="row.connectionId ? ['settings', 'disconnect'] : []"
				show-status-label
				menu-activator-icon="chevron-down"
				:variant="rowVariant(row)"
				:connect-label="i18n.baseText('instanceAi.connections.row.connect')"
				:connect-loading="connectingSlug === row.serverSlug"
				@connect="handleConnect(row)"
				@open-settings="openSettings(row)"
				@disconnect="handleDisconnect(row)"
			/>
		</div>

		<ConfirmationFooter v-if="isActionable" layout="row-between" bordered>
			<span :class="$style.browseAll">
				<N8nText size="small" color="text-light">
					{{ i18n.baseText('instanceAi.mcpConnect.browseAll.prompt') }}
				</N8nText>
				<button
					type="button"
					:class="$style.browseAllLink"
					data-test-id="instance-ai-mcp-connect-browse-all"
					@click="handleBrowseAll"
				>
					<N8nText size="small" color="text-dark">
						{{ i18n.baseText('instanceAi.mcpConnect.browseAll.link') }}
					</N8nText>
				</button>
			</span>
			<!-- Doubles as continue: with several rows offered, connecting one leaves the
			     card pending, and "Skip connecting" would misdescribe carrying on. -->
			<N8nButton
				variant="ghost"
				size="small"
				:disabled="!!connectingSlug"
				data-test-id="instance-ai-mcp-connect-resolve"
				@click="finish(anyConnected)"
			>
				{{
					i18n.baseText(
						anyConnected ? 'instanceAi.mcpConnect.continue' : 'instanceAi.mcpConnect.skip',
					)
				}}
			</N8nButton>
		</ConfirmationFooter>
	</div>
</template>

<style lang="scss" module>
.card {
	display: flex;
	flex-direction: column;
	max-width: 90%;
	border: var(--border);
	border-radius: var(--radius--lg);
	background-color: var(--background--surface);
}

.awaitingInput {
	border: 2px solid var(--color--primary);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--xs) var(--spacing--sm);
	border-bottom: var(--border);
}

.rows {
	display: flex;
	flex-direction: column;
	/* ConnectionRow carries its own left margin — subtract it so the row icon
	   lines up with the header icon. */
	padding: var(--spacing--2xs) var(--spacing--sm) var(--spacing--2xs)
		calc(var(--spacing--sm) - var(--spacing--2xs));
}

.browseAll {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.browseAllLink {
	padding: 0;
	border: none;
	background: none;
	cursor: pointer;
	text-decoration: underline;
}
</style>
