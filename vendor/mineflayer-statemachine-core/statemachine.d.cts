/** Minimal declarations for the upstream 1.7.0 core subset used by this adapter. */
export interface StateBehavior { stateName: string; active: boolean; onStateEntered?(): void; onStateExited?(): void; update?(): void }
export class StateTransition {
  constructor(options: { parent: StateBehavior; child: StateBehavior; name?: string; shouldTransition?: () => boolean; onTransition?: () => void });
  trigger(): void;
}
export class NestedStateMachine {
  constructor(transitions: StateTransition[], enter: StateBehavior, exit?: StateBehavior);
  active: boolean;
  activeState?: StateBehavior;
  onStateEntered(): void;
  onStateExited(): void;
  update(): void;
  isFinished(): boolean;
}
