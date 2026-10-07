"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NestedStateMachine = exports.BotStateMachine = exports.StateTransition = void 0;
const events_1 = require("events");
// Local integration: do not load the upstream behavior/webserver dependency graph.
const _1 = { globalSettings: { debugMode: false } };
/**
 * A transition that links when one state (the parent) should transition
 * to another state (the child).
 */
class StateTransition {
    /**
       * Creates a new one-way state transition between two states.
       *
       * @param parent - The state to move from.
       * @param child - The state to move to.
       * @param name - The name of this transition.
       * @param shouldTransition - Runs each tick to check if this transition should be called.
       * @param onTransition - Called when this transition is run.
       * @param transitionName - The unique name of this transition.
       */
    constructor({ parent, child, name, shouldTransition = () => false, onTransition = () => { } }) {
        this.triggerState = false;
        this.parentState = parent;
        this.childState = child;
        this.shouldTransition = shouldTransition;
        this.onTransition = onTransition;
        this.name = name;
    }
    /**
       * Triggers this transition to occur on the next Minecraft tick,
       * regardless of the "shouldTransition" function.
       *
       * @throws Exception if this transition is not yet bound to a
       * state machine.
       */
    trigger() {
        if (!this.parentState.active) {
            return;
        }
        this.triggerState = true;
    }
    /**
       * Checks if this transition if currently triggered to run. This is
       * separate from the shouldTransition function.
       *
       * @returns True if this transition was triggered to occur.
       */
    isTriggered() {
        return this.triggerState;
    }
    /**
       * Resets the triggered state to false.
       */
    resetTrigger() {
        this.triggerState = false;
    }
}
exports.StateTransition = StateTransition;
/**
 * An AI state machine which runs on a bot to help simplify complex
 * behavior trees.
 */
class BotStateMachine extends events_1.EventEmitter {
    /**
       * Creates a new, simple state machine for handling bot behavior.
       *
       * @param bot - The bot being acted on.
       * @param rootStateMachine - The root level state machine.
       */
    constructor(bot, rootStateMachine) {
        super();
        this.bot = bot;
        this.rootStateMachine = rootStateMachine;
        this.states = [];
        this.transitions = [];
        this.nestedStateMachines = [];
        this.findStatesRecursive(this.rootStateMachine);
        this.findTransitionsRecursive(this.rootStateMachine);
        this.findNestedStateMachines(this.rootStateMachine);
        this.bot.on('physicTick', () => this.update());
        this.rootStateMachine.active = true;
        this.rootStateMachine.onStateEntered();
    }
    findNestedStateMachines(nested, depth = 0) {
        this.nestedStateMachines.push(nested);
        nested.depth = depth;
        nested.on('stateChanged', () => this.emit('stateChanged'));
        for (const state of nested.states) {
            if (state instanceof NestedStateMachine) {
                this.findNestedStateMachines(state, depth + 1);
            }
        }
    }
    findStatesRecursive(nested) {
        for (const state of nested.states) {
            this.states.push(state);
            if (state instanceof NestedStateMachine) {
                this.findStatesRecursive(state);
            }
        }
    }
    findTransitionsRecursive(nested) {
        for (const trans of nested.transitions) {
            this.transitions.push(trans);
        }
        for (const state of nested.states) {
            if (state instanceof NestedStateMachine) {
                this.findTransitionsRecursive(state);
            }
        }
    }
    /**
       * Called each tick to update the root state machine.
       */
    update() {
        this.rootStateMachine.update();
    }
}
exports.BotStateMachine = BotStateMachine;
/**
 * A single state machine layer within the global state machine. Can recursively
 * contain nested state machines as well.
 *
 * This can be treated as a state behavior, allowing users to transition into
 * and out of this state machine without knowing it's internal components.
 */
class NestedStateMachine extends events_1.EventEmitter {
    /**
       * Creates a new nested state machine layer.
       * @param transitions - The list of transitions within this layer.
       * @param enter - The state to activate when entering this state.
       * @param exit - The state used to symbolize this layer has completed.
       */
    constructor(transitions, enter, exit) {
        super();
        /**
           * The name of this state behavior.
           */
        this.stateName = 'nestedStateMachine';
        /**
           * Whether or not this state machine layer is active.
           */
        this.active = false;
        /**
           * The depth of this layer within the entire state machine.
           */
        this.depth = 0;
        this.transitions = transitions;
        this.enter = enter;
        this.exit = exit;
        this.states = this.findStates();
    }
    findStates() {
        const states = [];
        states.push(this.enter);
        if (this.exit != null) {
            if (!states.includes(this.exit)) {
                states.push(this.exit);
            }
        }
        for (let i = 0; i < this.transitions.length; i++) {
            const trans = this.transitions[i];
            if (!states.includes(trans.parentState)) {
                states.push(trans.parentState);
            }
            if (!states.includes(trans.childState)) {
                states.push(trans.childState);
            }
        }
        return states;
    }
    onStateEntered() {
        var _a, _b;
        this.activeState = this.enter;
        this.activeState.active = true;
        (_b = (_a = this.activeState).onStateEntered) === null || _b === void 0 ? void 0 : _b.call(_a);
        if (_1.globalSettings.debugMode) {
            console.log(`Switched bot behavior state to '${this.activeState.stateName}'.`);
        }
        this.emit('stateChanged');
    }
    update() {
        var _a, _b, _c, _d, _e, _f;
        (_b = (_a = this.activeState) === null || _a === void 0 ? void 0 : _a.update) === null || _b === void 0 ? void 0 : _b.call(_a);
        for (let i = 0; i < this.transitions.length; i++) {
            const transition = this.transitions[i];
            if (transition.parentState === this.activeState) {
                if (transition.isTriggered() || transition.shouldTransition()) {
                    transition.resetTrigger();
                    this.activeState.active = false;
                    (_d = (_c = this.activeState).onStateExited) === null || _d === void 0 ? void 0 : _d.call(_c);
                    transition.onTransition();
                    this.activeState = transition.childState;
                    this.activeState.active = true;
                    if (_1.globalSettings.debugMode) {
                        console.log(`Switched bot behavior state to '${this.activeState.stateName}'.`);
                    }
                    this.emit('stateChanged');
                    (_f = (_e = this.activeState).onStateEntered) === null || _f === void 0 ? void 0 : _f.call(_e);
                    return;
                }
            }
        }
    }
    onStateExited() {
        var _a, _b;
        if (this.activeState == null)
            return;
        this.activeState.active = false;
        (_b = (_a = this.activeState).onStateExited) === null || _b === void 0 ? void 0 : _b.call(_a);
        this.activeState = undefined;
    }
    /**
       * Checks whether or not this state machine layer has finished running.
       */
    isFinished() {
        if (this.active == null)
            return true;
        if (this.exit == null)
            return false;
        return this.activeState === this.exit;
    }
}
exports.NestedStateMachine = NestedStateMachine;
