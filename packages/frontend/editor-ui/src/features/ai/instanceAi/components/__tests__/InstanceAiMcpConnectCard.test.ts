import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/vue';
import { nextTick, reactive } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { createComponentRenderer } from '@/__tests__/render';
import { INSTANCE_AI_TOOLS_CONNECTION_MODAL_KEY } from '@/app/constants/modals';
import InstanceAiMcpConnectCard from '../InstanceAiMcpConnectCard.vue';

vi.mock('@n8n/i18n', async (importOriginal) => ({
	...(await importOriginal()),
	useI18n: () => ({ baseText: (key: string) => key }),
}));

const mcpStoreMock = vi.fn();
vi.mock('../../instanceAiMcp.store', () => ({
	useInstanceAiMcpStore: () => mcpStoreMock(),
}));

const { telemetryMock, uiStoreMock, connectServerMock } = vi.hoisted(() => ({
	telemetryMock: { trackToolsListOpened: vi.fn(), trackSettingsOpened: vi.fn() },
	uiStoreMock: { openModal: vi.fn(), openModalWithData: vi.fn(), appliedTheme: 'light' },
	connectServerMock: vi.fn(),
}));

vi.mock('../../instanceAiMcp.telemetry', () => ({
	useInstanceAiMcpTelemetry: () => telemetryMock,
}));

vi.mock('@/app/stores/ui.store', () => ({ useUIStore: () => uiStoreMock }));

vi.mock('../../composables/useMcpServerConnect', () => ({
	useMcpServerConnect: () => ({ connectServer: connectServerMock }),
}));

const BRAVE_PAYLOAD = { serverSlug: 'brave', title: 'Brave', tagline: 'Search the web' };

const BRAVE_CATALOG_ENTRY = {
	slug: 'brave',
	name: 'brave',
	title: 'Brave Search',
	description: 'Brave',
	tagline: 'Search the web with Brave Search',
	version: '1',
	updatedAt: '2026-01-01',
	icons: [],
	credentialType: 'braveMcpOAuth2Api',
	tools: [],
	isOfficial: true,
	status: 'active' as const,
};

function makeMcpStore(overrides: Record<string, unknown> = {}) {
	return reactive({
		catalog: [BRAVE_CATALOG_ENTRY],
		connections: [] as Array<{ id: string; serverSlug: string }>,
		fetchCatalogLazy: vi.fn(),
		ensureConnectionsLoaded: vi.fn(),
		disconnect: vi.fn(),
		...overrides,
	});
}

const renderComponent = createComponentRenderer(InstanceAiMcpConnectCard);

describe('InstanceAiMcpConnectCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setActivePinia(createTestingPinia({ stubActions: false }));
		mcpStoreMock.mockReturnValue(makeMcpStore());
	});

	it('prefers the live registry entry over the payload snapshot', () => {
		const { getByText } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		expect(getByText('Brave Search')).toBeVisible();
		expect(getByText('Search the web with Brave Search')).toBeVisible();
	});

	it('falls back to the payload snapshot before the catalog loads', () => {
		mcpStoreMock.mockReturnValue(makeMcpStore({ catalog: null }));

		const { getByText } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		expect(getByText('Brave')).toBeVisible();
		expect(getByText('Search the web')).toBeVisible();
	});

	it('resolves with the connected slug once a server is connected', async () => {
		const store = makeMcpStore();
		mcpStoreMock.mockReturnValue(store);
		connectServerMock.mockImplementation(() => {
			store.connections.push({ id: 'conn-1', serverSlug: 'brave' });
			return Promise.resolve('conn-1');
		});
		const { getByTestId, emitted } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		await fireEvent.click(getByTestId('instance-ai-connection-row-primary-action'));

		expect(connectServerMock).toHaveBeenCalledWith({
			slug: 'brave',
			credentialType: 'braveMcpOAuth2Api',
		});
		expect(emitted().resolve).toEqual([[{ approved: true, connectedSlugs: ['brave'] }]]);
	});

	it('resolves when the last row is connected from another surface', async () => {
		const store = makeMcpStore();
		mcpStoreMock.mockReturnValue(store);
		const { emitted } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		expect(emitted().resolve).toBeUndefined();

		store.connections.push({ id: 'conn-1', serverSlug: 'brave' });
		await nextTick();

		expect(emitted().resolve).toEqual([[{ approved: true, connectedSlugs: ['brave'] }]]);
	});

	it('stays pending while only some rows are connected elsewhere', async () => {
		const store = makeMcpStore();
		mcpStoreMock.mockReturnValue(store);
		const { emitted, getByTestId } = renderComponent({
			props: { servers: [BRAVE_PAYLOAD, { serverSlug: 'exa', title: 'Exa' }] },
		});

		store.connections.push({ id: 'conn-1', serverSlug: 'brave' });
		await nextTick();

		expect(emitted().resolve).toBeUndefined();
		expect(getByTestId('instance-ai-mcp-connect-resolve')).toBeVisible();
	});

	it('stays pending when the user backs out of the credential flow', async () => {
		connectServerMock.mockResolvedValue(null);
		const { getByTestId, emitted } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		await fireEvent.click(getByTestId('instance-ai-connection-row-primary-action'));

		expect(emitted().resolve).toBeUndefined();
	});

	it('resolves as unapproved when skipped', async () => {
		const { getByTestId, emitted } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		await fireEvent.click(getByTestId('instance-ai-mcp-connect-resolve'));

		expect(emitted().resolve).toEqual([[{ approved: false, connectedSlugs: [] }]]);
	});

	it('continues as approved with what was connected when some rows are left', async () => {
		mcpStoreMock.mockReturnValue(
			makeMcpStore({ connections: [{ id: 'conn-1', serverSlug: 'brave' }] }),
		);
		const { getByTestId, emitted } = renderComponent({
			props: { servers: [BRAVE_PAYLOAD, { serverSlug: 'exa', title: 'Exa' }] },
		});

		expect(getByTestId('instance-ai-mcp-connect-resolve')).toHaveTextContent(
			'instanceAi.mcpConnect.continue',
		);

		await fireEvent.click(getByTestId('instance-ai-mcp-connect-resolve'));

		expect(emitted().resolve).toEqual([[{ approved: true, connectedSlugs: ['brave'] }]]);
	});

	it('offers a skip label while nothing is connected', () => {
		const { getByTestId } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		expect(getByTestId('instance-ai-mcp-connect-resolve')).toHaveTextContent(
			'instanceAi.mcpConnect.skip',
		);
	});

	it('opens the tools modal from browse all', async () => {
		const { getByTestId } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		await fireEvent.click(getByTestId('instance-ai-mcp-connect-browse-all'));

		expect(telemetryMock.trackToolsListOpened).toHaveBeenCalled();
		expect(uiStoreMock.openModal).toHaveBeenCalledWith(INSTANCE_AI_TOOLS_CONNECTION_MODAL_KEY);
	});

	it('shows a connected row with no connect button and no footer', () => {
		mcpStoreMock.mockReturnValue(
			makeMcpStore({ connections: [{ id: 'conn-1', serverSlug: 'brave' }] }),
		);

		const { queryByTestId, getByTestId, getByText } = renderComponent({
			props: { servers: [BRAVE_PAYLOAD], readOnly: true },
		});

		expect(queryByTestId('instance-ai-connection-row-primary-action')).toBeNull();
		expect(queryByTestId('instance-ai-mcp-connect-resolve')).toBeNull();
		expect(getByText('instanceAi.connections.row.status.connected')).toBeVisible();
		expect(getByTestId('instance-ai-connection-row-status')).toBeVisible();
	});

	it('renders no actions once read-only', () => {
		const { queryByTestId } = renderComponent({
			props: { servers: [BRAVE_PAYLOAD], readOnly: true },
		});

		expect(queryByTestId('instance-ai-connection-row-primary-action')).toBeNull();
		expect(queryByTestId('instance-ai-mcp-connect-resolve')).toBeNull();
	});

	it('renders the expired title with no actions', () => {
		const { getByText, queryByTestId } = renderComponent({
			props: { servers: [BRAVE_PAYLOAD], expired: true },
		});

		expect(getByText('instanceAi.mcpConnect.titleExpired')).toBeVisible();
		expect(queryByTestId('instance-ai-mcp-connect-resolve')).toBeNull();
	});

	it('offers no connect button while the credential type is unknown', () => {
		mcpStoreMock.mockReturnValue(makeMcpStore({ catalog: [] }));

		const { queryByTestId, getByTestId } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

		expect(queryByTestId('instance-ai-connection-row-primary-action')).toBeNull();
		expect(getByTestId('instance-ai-mcp-connect-resolve')).toBeVisible();
	});

	// Without the payload fallback a failed catalog fetch leaves Skip as the only
	// action, which reads as "this tool can't be connected".
	it('connects from the payload credential type when the catalog is unavailable', async () => {
		mcpStoreMock.mockReturnValue(makeMcpStore({ catalog: null }));

		const { getByTestId } = renderComponent({
			props: { servers: [{ ...BRAVE_PAYLOAD, credentialType: 'braveMcpOAuth2Api' }] },
		});

		await fireEvent.click(getByTestId('instance-ai-connection-row-primary-action'));

		expect(connectServerMock).toHaveBeenCalledWith({
			slug: 'brave',
			credentialType: 'braveMcpOAuth2Api',
		});
	});

	describe('rows that were never connected', () => {
		it('reports no status after skipping', async () => {
			const { getByTestId, queryByTestId, queryByText } = renderComponent({
				props: { servers: [BRAVE_PAYLOAD] },
			});

			await fireEvent.click(getByTestId('instance-ai-mcp-connect-resolve'));

			expect(queryByTestId('instance-ai-connection-row-status')).toBeNull();
			expect(queryByText('instanceAi.connections.row.status.disconnected')).toBeNull();
		});

		it('reports no status once read-only', () => {
			const { queryByTestId, queryByText } = renderComponent({
				props: { servers: [BRAVE_PAYLOAD], readOnly: true },
			});

			expect(queryByTestId('instance-ai-connection-row-status')).toBeNull();
			expect(queryByText('instanceAi.connections.row.status.disconnected')).toBeNull();
		});

		it('reports no status once expired', () => {
			const { queryByTestId, queryByText } = renderComponent({
				props: { servers: [BRAVE_PAYLOAD], expired: true },
			});

			expect(queryByTestId('instance-ai-connection-row-status')).toBeNull();
			expect(queryByText('instanceAi.connections.row.status.disconnected')).toBeNull();
		});

		it('reports no status while the credential type is unknown', () => {
			mcpStoreMock.mockReturnValue(makeMcpStore({ catalog: [] }));

			const { queryByTestId } = renderComponent({ props: { servers: [BRAVE_PAYLOAD] } });

			expect(queryByTestId('instance-ai-connection-row-status')).toBeNull();
		});
	});
});
