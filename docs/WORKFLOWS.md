# Bounded survival workflows

These tools add session-local, explicitly stepped workflows on the **existing bot,
controller and serialized action lane**. They do not start a scheduler or resume
work after a disconnect. All evidence described below is offline fixture evidence;
no real server has been used to accept these workflows.

## Tools and progression

- `plan-gather-workflow`: inspect explicit loaded terrain targets and selected
  storage, then prepare one gather → return → deposit → restock cycle
- `plan-blueprint-workflow`: import bounded prismarine-schematic JSON, calculate
  materials, detect occupied/unloaded/unsupported cells, and order supported
  survival placements against existing or previously planned support
- `read-workflow`: inspect status, revision and per-step evidence, including while
  a batch is running; reads never execute work
- `run-workflow`: execute 1–4 steps (default 1), supplying the plan's current
  `expectedRevision`; each batch has a 90-second cancellation deadline
- `cancel-workflow`: cancel one plan or interrupt its active batch without waiting
  behind that batch's action lane

Planning changes only bounded in-memory plan state, never the game. At most 32
plans are retained for one backend session, with at most 512 steps per plan.
Review the returned actions/materials before explicitly running a plan. No
background loop repeats the cycle. General stop, death and session end cancel
prepared and active workflows. Backend replacement does not restore them.

Every step is marked `submitted` **before** equipment, navigation, or the intended
operation begins. Only explicit effect evidence marks it `confirmed`. Failure or
cancellation ends the workflow permanently; an interrupted submitted step is
`uncertain`. Confirmed earlier steps stay recorded. `expectedRevision` rejects
repeated/stale requests instead of treating them as a request for the next step.
A successful batch increments that revision and stops; the caller must explicitly
request the next batch with the new revision. Nothing rolls back consumed items.

Cancellation requests release navigation and digging, and the underlying action
must settle before the serial lane is released. A cancellation response can show
`cancelling` until that drain completes. The outer action may return a cancellation
error; use `read-workflow` to inspect retained progress. Never automatically resend
an uncertain request after a transport error, even with the same arguments.

## Gather, storage and supplies

Supply exact target coordinates, observed block names and expected item names.
This first stage supports dirt/grass, stone/cobblestone, granite, diorite, andesite
and deepslate/cobbled-deepslate, with one expected item per target. It accepts at
most 16 unique targets within 32 blocks and an observed chest/barrel within 64
blocks. It rejects nearby fluids, unknown neighbours and falling-block risks.

Each target uses the existing `mineflayer-tool` selector with chest retrieval
**disabled**, verified movement, protected `dig-block`, and observed pickup
movement. Two free server-authoritative inventory slots are required. A removed
block is not enough: a fresh authoritative inventory increase in the expected
item is required. That increase is evidence of inventory gain, not proof that
no unrelated nearby item contributed to it. Specialised tools, enchanted drops,
ore mining, forestry, crops, chained falling blocks and farm cycles are deferred.

Deposit and restock entries specify item names and exact counts, not broad
"everything" filters. Each transfer reopens only the selected chest/barrel,
checks the authoritative window layout, transfers through the existing verified
slot adapter, and closes only after confirmation. Capacity, item identity and
stock are rechecked at execution time; a missing supply stops the workflow after
any already-confirmed deposit. No item is dropped for overflow. The workflow
never crafts missing supplies, uses a different chest, or automatically retries.
Low health (<10), hunger (<6), a dimension change, or an inventory fence stops
execution. These bounds supplement user authorization and server rules; a block
name does not prove that terrain belongs to the user or was naturally generated.

### Example plan arguments

```json
{
  "targets": [{
    "position": {"x": 4, "y": 64, "z": 2},
    "block": "dirt", "item": "dirt", "minimum": 1
  }],
  "chest": {"x": 1, "y": 64, "z": 1},
  "deposit": [{"item": "dirt", "count": 1}],
  "restock": [{"item": "bread", "count": 2}]
}
```

Coordinates are illustrative; plan only targets actually observed and authorized
in the current world. Creating a plan does not approve a server or its actions.

## Blueprint input and limits

`schematic` is the object emitted by
[`prismarine-schematic`'s `toJSON()`](https://github.com/PrismarineJS/prismarine-schematic):
`version`, `size`, `offset`, numeric block-state `palette`, and palette-index
`blocks` in y/z/x order. Pass the parsed object, not a JSON string. `origin` is a
separate world coordinate. Version must be `1.21.1`; each size axis is 1–16,
volume is at most 512, offset axes are −16…16, and palette entries must be known
in the current registry. The existing parser is used after strict size/index
validation. The tool does not read paths, fetch URLs, parse compressed NBT, or
execute schematic-generated commands.

Only allowlisted non-directional single-state building blocks are executable,
including plain stone/brick families, planks, wool, concrete, glass and terracotta.
Unsupported states, insufficient carried materials, unloaded cells, occupied
cells, or absent support return a blocked plan with **no executable workflow**.
Already matching cells need no item; schematic air cells always preserve the
world. The bot never clears a region, replaces a conflicting block, places TNT,
automatically scaffolds, configures a container, writes block-entity NBT, or
constructs directional/multipart blocks. It does not find an optimal building
stance; inaccessible placement fails safely rather than expanding the plan.

Before each placement, the target is re-observed. Existing matching blocks are
recorded without claiming a new placement. Otherwise, the existing equipment and
`place-block` guards must succeed, a fresh exact one-item decrease must be observed,
and the exact requested state must be present. No inventory success is inferred
from an upstream helper returning normally. Supported JSON can be produced with
the upstream library outside this runtime; binary `.schem`/`.schematic` ingestion,
litematic, orientation/NBT, auto-supply and full survival builders remain deferred.

## Ecology reuse and rationale

- [`mineflayer-statemachine` 1.7.0](https://github.com/PrismarineJS/mineflayer-statemachine):
  the MIT-licensed core is preserved in `vendor/mineflayer-statemachine-core`.
  Only `NestedStateMachine` and `StateTransition` are manually advanced. The
  full package pulls in a Node 19 installation package, web server and background
  behavior graph; none is installed or started for this integration. See that
  directory's notice for the exact small source change
- [`prismarine-schematic` 1.3.0](https://github.com/PrismarineJS/prismarine-schematic):
  reused for bounded JSON palette/coordinate interpretation, never its command
  generator or world-paste methods
- Existing `mineflayer-tool`, verified navigation/digging/placement, inventory
  authority and window transfers are reused rather than replaced

The pre-existing `mineflayer-collectblock` plugin remains installed. Its block
collection checks pathfinder `safeToBreak`, which returns false with this runtime's
mandatory `canDig=false` movement policy. A plugin return/count alone therefore
cannot certify collected blocks. This workflow deliberately uses explicit,
protected digging and authoritative pickup verification instead of enabling
pathfinder terrain destruction or advertising an unverified collection result.

## Workstation evidence correction

Villager trading, enchanting and anvils already have implemented verified adapters
in `src/verified-workstation-actions.ts`, with dedicated tests in
`tests/reviewer-complete-controls.test.ts`. They are not missing/catalog-only
features. That suite checks fresh merchant offers, exact payment/output,
cancellation/timeouts, enchanting input return and lapis/experience consumption,
anvil name/repair output and costs. These are synthetic protocol fixtures, not
live-server acceptance. Broader brewing/smithing/loom/cartography automation and
full farm workflows remain outside this stage.

## Verification

- `tests/bounded-workflows.test.ts`: revision/no-replay, terminal uncertainty,
  cancellation drain, plan isolation and stop-all behavior
- `tests/blueprint-plan.test.ts`: actual schematic interpretation, materials,
  offsets/order, no-clear air semantics, conflict/unsupported/stale/unloaded input
- `tests/workflow-tools.test.ts`: gather → storage → restock with authoritative
  fixture packets, exact blueprint consumption/state, partial failure, cancellation,
  changed targets/dimension and inventory fences
- Existing workstation fixtures were rerun unchanged; their passing results do
  not upgrade them to real-world validation
