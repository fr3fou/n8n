import type { IDataObject, INodeParameters, INodeType, INodeTypes } from 'n8n-workflow';
import { Workflow, WEBHOOK_RESOLVERS, webhookDescriptionIsNativelyResolvable } from 'n8n-workflow';

import { defaultWebhookDescription } from '../description';
import { Webhook } from '../Webhook.node';

// Pins what lets `LiveWebhooks` resolve this description without the expression
// engine: every field declares a native resolver (or is a plain value), each
// resolver returns exactly what its template returns through the engine, and
// the generated template strings are the long-standing hand-written ones the
// editor keeps evaluating.

const webhookNode = new Webhook();

const nodeTypes: INodeTypes = {
	getByName: () => webhookNode as unknown as INodeType,
	getByNameAndVersion: () => webhookNode as unknown as INodeType,
	getKnownTypes: () => ({}) as IDataObject,
};

const nodeWithParameters = (parameters: INodeParameters) => {
	const workflow = new Workflow({
		id: '1',
		nodes: [
			{
				name: 'Webhook',
				type: 'n8n-nodes-base.webhook',
				typeVersion: 2.1,
				id: 'webhook-1',
				position: [0, 0],
				parameters,
			},
		],
		connections: {},
		active: true,
		nodeTypes,
	});

	return { workflow, node: workflow.getNode('Webhook')! };
};

describe('defaultWebhookDescription', () => {
	it('is fully resolvable without the expression engine', () => {
		expect(webhookDescriptionIsNativelyResolvable(defaultWebhookDescription)).toBe(true);
	});

	it('generates the same template strings the description has always shipped', () => {
		expect(defaultWebhookDescription).toMatchObject({
			httpMethod: '={{$parameter["httpMethod"] || "GET"}}',
			responseMode: '={{$parameter["responseMode"]}}',
			responseBinaryPropertyName: '={{$parameter["responseBinaryPropertyName"]}}',
			responseContentType: '={{$parameter["options"]["responseContentType"]}}',
			responsePropertyName: '={{$parameter["options"]["responsePropertyName"]}}',
			responseHeaders: '={{$parameter["options"]["responseHeaders"]}}',
			path: '={{$parameter["path"]}}',
		});
		// The function-body templates inline the functions' source, as before.
		expect(defaultWebhookDescription.responseCode).toMatch(/^=\{\{\(.+\)\(\$parameter\)\}\}$/s);
		expect(defaultWebhookDescription.responseData).toMatch(/^=\{\{\(.+\)\(\$parameter\)\}\}$/s);
	});

	describe('resolvers match their templates', () => {
		const parameterSets: Array<[string, INodeParameters]> = [
			['defaults only', {}],
			['respond immediately with a fixed body', { responseMode: 'onReceived', options: {} }],
			[
				'last node, all entries',
				{ responseMode: 'lastNode', responseData: 'allEntries', options: {} },
			],
			['respond via node', { responseMode: 'responseNode', options: {} }],
			['no response body', { responseMode: 'onReceived', options: { noResponseBody: true } }],
			[
				'response data from options',
				{ responseMode: 'onReceived', options: { responseData: 'noData' } },
			],
			['custom status code', { options: { responseCode: { values: { responseCode: 201 } } } }],
			[
				'custom status code with a custom value',
				{ options: { responseCode: { values: { responseCode: 0, customCode: 418 } } } },
			],
			['legacy typeVersion 1 status code', { responseCode: 302, options: {} }],
			['multiple methods', { httpMethod: ['GET', 'POST'], multipleMethods: true, options: {} }],
		];

		const resolvers = defaultWebhookDescription[WEBHOOK_RESOLVERS]!;

		describe.each(parameterSets)('%s', (_name, parameters) => {
			const { workflow, node } = nodeWithParameters(parameters);

			test.each(Object.keys(resolvers))('%s', (field) => {
				const native = resolvers[field].resolve(node.parameters);

				const viaEngine = workflow.expression.getSimpleParameterValue(
					node,
					defaultWebhookDescription[field] as string,
					'internal',
					{},
				);

				expect(native).toEqual(viaEngine);
			});
		});
	});
});
