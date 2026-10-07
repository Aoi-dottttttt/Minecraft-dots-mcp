# Reactive monster self-defense V2 (unreleased review patch)

Default-off and session-only, for Java 1.21.1 / protocol 767. Uses the existing
bot, controller authorization, inventory authority and shared action lane. No
second connection, persistent configuration, automatic respawn/reconnect,
unrestricted PVP, construction resumption or inventory retry is introduced.
The status identifies `implementation: "ranged-defense-v2"`.

## Explicit controls and preparation

- Prepare a usable axe/sword in the hotbar and a shield in the off hand, while
  safe, using the normal verified equipment tools. Armor is not auto-equipped
- `self-defense-enable {}` arms only a live healthy current session with closed
  inventory window, empty cursor and no uncertainty fence
- `self-defense-status {}` reads state, limits, alerts and exact outcome evidence
- `self-defense-disable {}` invalidates queued/future defense immediately,
  releases shield/directional controls and drains only its submitted work
- `stop-movement {}` is the emergency stop: it also disables defense

Enable uses normal controller/connection/mutation gates. Status and disable
remain available when foreground work is busy or fenced. Disable is authorized
cleanup, never a read-only bypass. Queued enable requests invalidated by a stop
or lifecycle event cannot silently reactivate the feature. Existing backends do
not acquire V2 merely because source/frontend files change; a separately
approved installation and new session is required.

## Source and target evidence

Only a server `damage_event` for this player starts/renews an encounter.
`sourceCauseId - 1` identifies the causing entity, including a projectile's
shooter. Direct projectile IDs, arrow direction, proximity and animations never
substitute for missing causing-entity evidence.

The exact still-tracked entity must have the registry's expected type and belong
to the fixed monster allowlist. Players, pets/animals, villagers, golems, bosses,
neutral/unsupported species, custom names, ownership/taming markers, riders,
passengers and replaced/stale identities fail closed. Plugin ownership/disguise
compatibility is not certified. Unknown/protected sources never select a nearby
mob for retaliation. Multiple attributed attackers stop attacks and produce an
explicit warning: one shield cannot protect every direction. Facing uses the
most recently attributed allowed attacker; it is not proof of blocked damage.

Only `entityDead` of the exact target confirms its observed death, not exclusive
credit for that death. `entityGone`, lost identity, quiet periods, attack requests
and route completion are never reported as kills.

## Equipment and inventory safety

A usable held weapon is retained. Otherwise V2 selects only an existing usable
hotbar weapon, preferring an axe among alternatives. It does not perform storage
clicks, change armor or equip a spare shield during an attack. A sword is refused
when its sweep could hit nearby bystanders. Weapon identity, durability, health,
source, sight and range are rechecked immediately before each attack.

Ordinary verified equipment transfers now permit one narrow concurrent change:
a fresh server revision on an unrelated armor slot may increase the integer
`damage` component within that item's legal durability range, with item type,
count and every other component unchanged. Every observed revision is checked;
repairs, rollback-then-restore, changed components/count/type, breakage or loss
remain errors. Source/target/scratch/cursor are still checked exactly. The
exception neither clears an existing fence nor excuses an unconfirmed transfer.

## Guard, movement and finite action budgets

- Melee remains within three blocks with clear loaded sight, using individual
  requests at least 1250 ms apart for axes or 700 ms for swords
- Attacks stop at health at most 8/20, six health points lost, multiple/unknown
  sources, 12 seconds or 16 requests. These budgets never renew on fresh damage
- Off-hand shield use remains held between pulses, facing the attributed source.
  A new damage event renews an eight-second quiet lease; no-route state stays in
  `guarding` rather than dropping protection permanently after 250 ms
- Passive guard can continue through sustained server damage. It does not renew
  combat/movement budgets. At lease expiry an already-attributed, still-valid
  source in clear loaded sight within 24 blocks renews passive guard even without
  damage: successful shield blocks may produce no damage event. Otherwise eight
  seconds without damage ends the episode without a kill claim. New damage during
  cooldown starts a fresh response immediately
- A 2.5-second watchdog releases item use and blocks defense if physics/queue
  updates stop. Each ordinary pulse finishes quickly; no sleep occupies the lane
- Movement is limited to three requested steps total, each at most 1500 ms, with
  a four-block leash from the damage origin. Low-health retreat attempts stop
  after four seconds; active movement also ends after the 12-second combat window
- Every step uses loaded full-block same-level support and a swept 0.6-wide body
  corridor with two clear air cells. Furniture beside a corridor and slab roofs
  above it can be accepted; slab floors/thresholds, ladders, doors, slopes, water,
  lava, hazardous/slippery support, unknown chunks and unsupported edges are not
- Two loaded, occluded source-to-body rays identify a candidate cover location.
  Nearby observed entities are avoided. Otherwise a retreat increases distance
  from all attributed threats; a healthy single-target approach additionally
  needs a ready shield, source within six blocks and melee-reachable endpoint
- Ordinary forward/back/left/right keys keep yaw facing the source. Pathfinder is
  stopped and never turns the shield away to follow an escape heading. No jump,
  sprint, digging, placement, block interaction or world editing is issued
- Route geometry, health and identity are rechecked while moving. A failed step
  is not retried; controls clear, movement budget is exhausted and guard remains

No safe route, missing/broken shield, shield cooldown, armor loss, multiple
attackers and unknown sources are explicit alerts requiring attention. A shield
request is reported as `shieldRequestActive`; `shieldEffectConfirmed` remains
false. Neither those fields nor a geometric cover candidate establish protection,
actual hit prevention, safe server acceptance or survival. A depleted shield is
not silently replaced from inventory. Existing authority uncertainty still blocks
defense rather than bypassing conservation checks.

## Interruption, lifecycle and no replay

Damage interrupts only safely cancellable navigation/movement/dig scopes.
Submitted inventory/crafting/window/placement operations retain the lane until
their confirmation/failure; the next primitive then stops without replay. Any
confirmed changes remain, and new work requires inspecting that result.

Coalesced defense pulses use bounded-fair priority: at most one precedes an
already-waiting normal lane entry. Foreground mutations are refused during an
encounter; read-only status remains usable. Explicit stop/disable cancels defense
movement and releases shield immediately, including while a look/movement update
settles. Death, disconnect, kick, respawn, spawn and dimension change disable
future defense and clear old targets. No automatic reconnect or respawn exists.

## Verification boundary

Deterministic offline fixtures first reproduce the old armor-wear fence and the
single-shield no-route shutdown. Coverage includes protocol-767 damage attribution
and actual pinned Mineflayer shield activation/release bytes, continued arrows,
unknown/protected sources, shield cooldown/breakage, armor loss, furniture/slab/
ladder/edge geometry, bounded approach/retreat, directional locked-physics checks,
quiet leases/watchdog, manual stop, source loss, queue fairness and all existing
inventory conservation/cancellation rules. Full-project checks are reported
separately; a passing fixture is not real-server acceptance.

V2 has not established actual shield timing/effect, item-use movement slowdown,
server latency/knockback/corrections, enemy AI, plugin ownership, live survival or
successful retreat. Those require an authorized controlled live test with an
operator watching health and equipment; do not present this as unattended safety.
