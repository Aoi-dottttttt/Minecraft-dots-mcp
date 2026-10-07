import test from 'ava';
import { BoundedWorkflows, type WorkflowStep } from '../src/bounded-workflows.js';

const steps: WorkflowStep[] = [
  { kind: 'move', position: { x: 0, y: 64, z: 0 }, range: 2 },
  { kind: 'move', position: { x: 1, y: 64, z: 0 }, range: 2 },
];

test('workflow: submitted steps are never replayed with a stale revision', async t => {
  const calls: string[] = [];
  const workflows = new BoundedWorkflows(async step => { calls.push(step.kind); return { confirmed: true }; });
  const plan = workflows.create('gather', steps);
  const first = await workflows.run(plan.id, plan.revision, 1);
  t.is(first.nextStep, 1); t.is(first.status, 'ready');
  await t.throwsAsync(workflows.run(plan.id, plan.revision, 1), { message: /revision/ });
  t.is(calls.length, 1);
  const done = await workflows.run(plan.id, first.revision, 1);
  t.is(done.status, 'completed'); t.is(calls.length, 2);
  await t.throwsAsync(workflows.run(plan.id, done.revision, 1), { message: /completed/ });
});

test('workflow: an unconfirmed result halts permanently without advancing', async t => {
  let calls = 0;
  const workflows = new BoundedWorkflows(async () => { calls++; return { confirmed: false }; });
  const plan = workflows.create('gather', steps);
  const result = await workflows.run(plan.id, 0, 2);
  t.is(result.status, 'failed'); t.is(result.nextStep, 0); t.is(result.steps[0].status, 'uncertain');
  await t.throwsAsync(workflows.run(plan.id, result.revision, 1), { message: /failed/ });
  t.is(calls, 1);
});

test('workflow: cancellation drains current work and does not dispatch the next step', async t => {
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const drain = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const workflows = new BoundedWorkflows(async (_step, signal) => { calls++; started(); await drain; signal.throwIfAborted(); return { confirmed: true }; });
  const plan = workflows.create('gather', steps);
  const running = workflows.run(plan.id, 0, 2);
  await start; const cancellation = workflows.cancel(plan.id);
  t.is(cancellation.status, 'cancelling'); t.is(calls, 1);
  let settled = false; void running.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); t.false(settled);
  release(); const result = await running;
  t.is(result.status, 'cancelled'); t.is(calls, 1); t.is(result.steps[0].status, 'uncertain');
});

test('workflow: returned snapshots cannot mutate the stored plan or its submitted evidence', async t => {
  let observed = 0;
  const workflows = new BoundedWorkflows(async step => { observed = step.position.x; return { confirmed: true }; });
  const plan = workflows.create('gather', steps);
  plan.steps[0].action.position.x = 999;
  const result = await workflows.run(plan.id, 0, 1);
  t.is(observed, 0); result.steps[0].status = 'pending';
  t.is(workflows.snapshot(plan.id).steps[0].status, 'confirmed');
});

test('workflow: cancellation of all prepared plans leaves no resumable automation', async t => {
  const workflows = new BoundedWorkflows(async () => ({ confirmed: true }));
  const a = workflows.create('gather', steps), b = workflows.create('blueprint', steps);
  workflows.cancelAll();
  t.is(workflows.snapshot(a.id).status, 'cancelled'); t.is(workflows.snapshot(b.id).status, 'cancelled');
  await t.throwsAsync(workflows.run(a.id, workflows.snapshot(a.id).revision), { message: /cancelled/ });
});
