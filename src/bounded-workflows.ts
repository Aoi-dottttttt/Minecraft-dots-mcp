import { randomUUID } from 'node:crypto';
import { NestedStateMachine, StateTransition, type StateBehavior } from '../vendor/mineflayer-statemachine-core/statemachine.cjs';

export type Position = { x: number; y: number; z: number };
export type WorkflowStep =
  | { kind: 'move'; position: Position; range: number }
  | { kind: 'gather'; position: Position; block: string; item: string; minimum: number }
  | { kind: 'deposit' | 'withdraw'; position: Position; item: string; count: number }
  | { kind: 'place'; position: Position; item: string; stateId: number };
type StepRecord = { action: WorkflowStep; status: 'pending' | 'submitted' | 'confirmed' | 'uncertain'; evidence?: Record<string, unknown> };
type Status = 'ready' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type WorkflowSnapshot = { id: string; kind: 'gather' | 'blueprint'; revision: number; status: Status; nextStep: number; steps: StepRecord[]; error?: string; automaticRetry: false; sessionOnly: true };
type Job = WorkflowSnapshot & { machine: NestedStateMachine; transitions: StateTransition[]; controller?: AbortController };
type Executor = (step: WorkflowStep, signal: AbortSignal) => Promise<Record<string, unknown>>;

/** Session-only plans; no timers, physics hooks, persistence, recovery, or replay. */
export class BoundedWorkflows {
  private jobs = new Map<string, Job>();
  constructor(private execute: Executor) {}

  create(kind: WorkflowSnapshot['kind'], actions: WorkflowStep[]): WorkflowSnapshot {
    if (!actions.length || actions.length > 512) throw Error('Workflow requires 1..512 steps');
    if (this.jobs.size >= 32) throw Error('Session workflow limit reached (32); retain and inspect existing plans');
    const states: StateBehavior[] = [...actions.map((step, i) => ({ stateName: `${i}:${step.kind}`, active: false })), { stateName: 'completed', active: false }];
    const transitions = actions.map((_step, i) => new StateTransition({ parent: states[i], child: states[i + 1] }));
    const machine = new NestedStateMachine(transitions, states[0], states.at(-1));
    machine.active = true; machine.onStateEntered();
    const job: Job = { id: randomUUID(), kind, revision: 0, status: 'ready', nextStep: 0,
      steps: structuredClone(actions).map(action => ({ action, status: 'pending' })), automaticRetry: false, sessionOnly: true, machine, transitions };
    this.jobs.set(job.id, job);
    return this.snapshot(job.id);
  }

  private get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw Error('Unknown workflow for this backend session; old sessions are never resumed');
    return job;
  }

  snapshot(id: string): WorkflowSnapshot {
    const job = this.get(id);
    return structuredClone({ id: job.id, kind: job.kind, revision: job.revision, status: job.status, nextStep: job.nextStep, steps: job.steps, error: job.error, automaticRetry: false, sessionOnly: true });
  }

  cancel(id: string): WorkflowSnapshot {
    const job = this.get(id);
    if (job.status === 'running' || job.status === 'cancelling') {
      job.status = 'cancelling'; job.controller?.abort();
    } else if (job.status === 'ready') {
      job.status = 'cancelled'; job.revision++; job.machine.onStateExited();
    }
    return this.snapshot(id);
  }

  cancelAll(): void { for (const job of this.jobs.values()) this.cancel(job.id); }

  async run(id: string, expectedRevision: number, maxSteps = 1, outerSignal?: AbortSignal): Promise<WorkflowSnapshot> {
    const job = this.get(id);
    if (job.revision !== expectedRevision) throw Error('Stale workflow revision; inspect status, never replay the submitted request');
    if (job.status !== 'ready') throw Error(`Workflow is ${job.status}; it cannot be resumed or replayed`);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 4) throw Error('maxSteps must be 1..4');
    outerSignal?.throwIfAborted();
    const controller = new AbortController();
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    job.controller = controller; job.status = 'running'; job.revision++;
    const deadline = setTimeout(() => controller.abort(Error('Workflow batch deadline exceeded')), 90000);
    try {
      for (let i = 0; i < maxSteps && job.nextStep < job.steps.length; i++) {
        signal.throwIfAborted();
        const step = job.steps[job.nextStep];
        if (step.status !== 'pending') throw Error('Submitted steps are never replayed');
        // Mark BEFORE dispatch, including equipment/navigation. Failure stays terminal.
        step.status = 'submitted';
        const evidence = await this.execute(structuredClone(step.action), signal);
        step.evidence = structuredClone(evidence);
        if (evidence.confirmed !== true) throw Error('Step has no explicit confirmation; inspect the world and inventory');
        step.status = 'confirmed';
        job.transitions[job.nextStep].trigger(); job.machine.update(); job.nextStep++; job.revision++;
        signal.throwIfAborted();
      }
      job.status = job.machine.isFinished() ? 'completed' : 'ready';
    } catch (error) {
      const step = job.steps[job.nextStep];
      if (step?.status === 'submitted') step.status = 'uncertain';
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.revision++; job.machine.onStateExited();
    } finally {
      clearTimeout(deadline); job.controller = undefined;
      if (job.status === 'completed') job.machine.onStateExited();
    }
    return this.snapshot(id);
  }
}
