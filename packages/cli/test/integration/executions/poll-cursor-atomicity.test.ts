import { createWorkflow, testDb } from '@n8n/backend-test-utils';
import type {
	CreateExecutionPayload,
	PollLeaseFence,
	ScheduledTask,
	WorkflowEntity,
} from '@n8n/db';
import {
	ExecutionEntity,
	ExecutionRepository,
	PollerStateRepository,
	ScheduledJobRepository,
	ScheduledTaskRepository,
	ScheduledTaskStatus,
	TransactionRunner,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { createEmptyRunExecutionData } from 'n8n-workflow';

import { ExecutionPersistence } from '@/executions/execution-persistence';
import { POLL_TRIGGER_TASK_TYPE } from '@/scheduling/poll-trigger-node/poll-trigger-task';
import { PollCursorService } from '@/workflows/triggers/poll-cursor.service';

import { createDueJobFactory, seedDueTask } from '../scheduling/shared/job-factory';

describe('poll cursor atomicity', () => {
	const nodeId = 'node-1';

	let pollCursorService: PollCursorService;
	let executionPersistence: ExecutionPersistence;
	let executionRepository: ExecutionRepository;
	let pollerStateRepository: PollerStateRepository;
	let scheduledJobRepository: ScheduledJobRepository;
	let scheduledTaskRepository: ScheduledTaskRepository;
	let transactionRunner: TransactionRunner;
	let workflow: WorkflowEntity;

	beforeAll(async () => {
		await testDb.init();
		pollCursorService = Container.get(PollCursorService);
		executionPersistence = Container.get(ExecutionPersistence);
		executionRepository = Container.get(ExecutionRepository);
		pollerStateRepository = Container.get(PollerStateRepository);
		scheduledJobRepository = Container.get(ScheduledJobRepository);
		scheduledTaskRepository = Container.get(ScheduledTaskRepository);
		transactionRunner = Container.get(TransactionRunner);
	});

	beforeEach(async () => {
		await testDb.truncate([
			'PollerState',
			'ExecutionEntity',
			'WorkflowEntity',
			'ScheduledTask',
			'ScheduledJob',
		]);
		workflow = await createWorkflow();
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	const buildPayload = (deduplicationKey?: string): CreateExecutionPayload => ({
		data: createEmptyRunExecutionData(),
		workflowData: workflow,
		mode: 'trigger',
		finished: false,
		status: 'new',
		workflowId: workflow.id,
		deduplicationKey,
	});

	const buildExecutionEntity = (): Partial<ExecutionEntity> => ({
		finished: false,
		mode: 'trigger',
		status: 'new',
		createdAt: new Date(),
		startedAt: new Date(),
		stoppedAt: new Date(),
		workflowId: workflow.id,
	});

	it('commits the cursor advance and the execution row together', async () => {
		await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

		const result = await pollCursorService.commitWithExecution({
			workflowId: workflow.id,
			nodeId,
			cursor: { lastItemId: 'b' },
			payload: buildPayload(),
		});
		if (result === null) throw new Error('expected a commit result');
		const { executionId } = result;

		expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
			lastItemId: 'b',
		});
		expect(await executionRepository.findOneBy({ id: executionId })).toMatchObject({
			status: 'new',
			workflowId: workflow.id,
		});
	});

	it('leaves the cursor unadvanced and writes no execution when the insert fails', async () => {
		await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

		const key = 'wf:node-1:t1';
		// A dispatched execution already holds this key, so the insert violates the
		// unique index from inside the transaction.
		const existingId = await executionPersistence.create({
			...buildPayload(key),
			status: 'running',
		});

		await expect(
			pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(key),
			}),
		).rejects.toThrow();

		expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
			lastItemId: 'a',
		});
		const executions = await executionRepository.find({ select: ['id'] });
		expect(executions.map((e) => e.id)).toEqual([existingId]);
	});

	it('persists a standalone cursor advance with no execution row', async () => {
		await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

		await pollCursorService.commitCursorOnly({
			workflowId: workflow.id,
			nodeId,
			nodeName: 'Poll Node',
			cursor: { lastItemId: 'b' },
			nodeStaticData: {},
		});

		expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
			lastItemId: 'b',
		});
		expect(await executionRepository.find({ select: ['id'] })).toEqual([]);
	});

	it('seeds the cursor from the given blob on the first read and keeps it afterwards', async () => {
		const seeded = await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', {
			lastItemId: 'from-static-data',
		});

		expect(seeded).toEqual({ lastItemId: 'from-static-data' });
		expect(
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', {
				lastItemId: 'ignored',
			}),
		).toEqual({ lastItemId: 'from-static-data' });
	});

	describe('ExecutionRepository.runInTransaction', () => {
		// The reverse of the rollback test above: there the insert fails, here the insert
		// succeeds and the caller fails afterwards, which only rolls the insert back if
		// the repository joined the caller's transaction rather than opening its own.
		it('joins the caller-supplied transaction so a later failure in the caller rolls back work already run through it', async () => {
			let executionId: string | undefined;

			await expect(
				transactionRunner.run({}, async (ctx) => {
					executionId = await executionRepository.runInTransaction(ctx, async (tx) => {
						const saved = await tx.save(ExecutionEntity, buildExecutionEntity());
						return saved.id;
					});
					throw new Error('caller fails after work already ran');
				}),
			).rejects.toThrow('caller fails after work already ran');

			expect(await executionRepository.findOneBy({ id: executionId })).toBeNull();
		});
	});

	describe('fenced commits', () => {
		let createDueJob: ReturnType<typeof createDueJobFactory>;

		beforeEach(() => {
			createDueJob = createDueJobFactory(
				scheduledJobRepository,
				POLL_TRIGGER_TASK_TYPE,
				'poll-fence-job',
			);
		});

		const seedRunningTask = async (
			overrides: Partial<ScheduledTask> = {},
		): Promise<ScheduledTask> => {
			const job = await createDueJob();
			const task = await seedDueTask(scheduledTaskRepository, POLL_TRIGGER_TASK_TYPE, job.id);
			return await scheduledTaskRepository.save({
				...task,
				status: ScheduledTaskStatus.Running,
				leaseEpoch: 1,
				leaseExpiresAt: new Date(Date.now() + 60_000),
				claimedBy: 'host-1',
				...overrides,
			});
		};

		it('does not commit when the fence lease epoch no longer matches the claimed task', async () => {
			const task = await seedRunningTask();
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });
			const fence: PollLeaseFence = { taskId: task.id, leaseEpoch: task.leaseEpoch };

			await scheduledTaskRepository.update(task.id, { leaseEpoch: task.leaseEpoch + 1 });

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence,
			});

			expect(result).toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'a',
			});
			expect(await executionRepository.find({ select: ['id'] })).toEqual([]);
		});

		it('does not commit when the fenced task row no longer exists', async () => {
			const task = await seedRunningTask();
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });
			const fence: PollLeaseFence = { taskId: task.id, leaseEpoch: task.leaseEpoch };

			await scheduledTaskRepository.delete(task.id);

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence,
			});

			expect(result).toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'a',
			});
			expect(await executionRepository.find({ select: ['id'] })).toEqual([]);
		});

		it('commits when the fence matches a task row still running', async () => {
			const task = await seedRunningTask();
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence: { taskId: task.id, leaseEpoch: task.leaseEpoch },
			});

			expect(result).not.toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'b',
			});
			expect(await executionRepository.findOneBy({ id: result?.executionId })).toMatchObject({
				status: 'new',
				workflowId: workflow.id,
			});
		});

		it('commits when the fenced task was already marked succeeded by its executor', async () => {
			const task = await seedRunningTask({ status: ScheduledTaskStatus.Succeeded });
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence: { taskId: task.id, leaseEpoch: task.leaseEpoch },
			});

			expect(result).not.toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'b',
			});
			expect(await executionRepository.findOneBy({ id: result?.executionId })).toMatchObject({
				status: 'new',
				workflowId: workflow.id,
			});
		});

		it('leaves no poller_state row behind when a first-ever poll is fenced out', async () => {
			const task = await seedRunningTask();
			const fence: PollLeaseFence = { taskId: task.id, leaseEpoch: task.leaseEpoch };
			await scheduledTaskRepository.update(task.id, { leaseEpoch: task.leaseEpoch + 1 });

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence,
			});

			expect(result).toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toBeNull();
		});

		it('commits when the fence lease epoch is 0 and matches the claimed task', async () => {
			const task = await seedRunningTask({ leaseEpoch: 0 });
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence: { taskId: task.id, leaseEpoch: 0 },
			});

			expect(result).not.toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'b',
			});
		});

		it('does not commit when the fenced task id never existed', async () => {
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });
			const fence: PollLeaseFence = { taskId: '999999999', leaseEpoch: 1 };

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence,
			});

			expect(result).toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'a',
			});
		});

		it('commits when the fence names a task claimed for a different workflow and node than the one being advanced', async () => {
			const unrelatedTask = await seedRunningTask();
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
				fence: { taskId: unrelatedTask.id, leaseEpoch: unrelatedTask.leaseEpoch },
			});

			expect(result).not.toBeNull();
			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'b',
			});
		});

		it('commits exactly as an unfenced call does today', async () => {
			await seedRunningTask();
			await pollCursorService.readCursor(workflow.id, nodeId, 'Poll Node', { lastItemId: 'a' });

			const result = await pollCursorService.commitWithExecution({
				workflowId: workflow.id,
				nodeId,
				cursor: { lastItemId: 'b' },
				payload: buildPayload(),
			});
			if (result === null) throw new Error('expected a commit result');
			const { executionId } = result;

			expect(await pollerStateRepository.findCursor(workflow.id, nodeId)).toEqual({
				lastItemId: 'b',
			});
			expect(await executionRepository.findOneBy({ id: executionId })).toMatchObject({
				status: 'new',
				workflowId: workflow.id,
			});
		});
	});
});
