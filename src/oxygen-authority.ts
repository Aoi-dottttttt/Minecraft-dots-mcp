import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';

export type OxygenEvidence = {
  source: 'self_entity_metadata'; known: boolean; entityId: number | null;
  rawAirSupply: number | null; oxygen: number | null; revision: number;
  observedAt: number | null; ageMs: number | null; reason: string | null;
};
type AirPacket = { entityId?: number; metadata?: Array<{ key?: number; type?: unknown; value?: unknown }> };
type Sample = { entity: Bot['entity']; entityId: number; dimension: unknown; rawAirSupply: number; observedAt: number };
const authorities = new WeakMap<Bot, OxygenAuthority>();
const unknown = (revision = 0, reason = 'No own-entity air metadata observed'): OxygenEvidence => ({
  source: 'self_entity_metadata', known: false, entityId: null, rawAirSupply: null,
  oxygen: null, revision, observedAt: null, ageMs: null, reason
});

/** Pinned Mineflayer 4.39.0 entities.js writes every entity's air_supply to
 * bot.oxygenLevel and emits an unattributed breath event. Neither is evidence.
 * This independent record accepts only raw current-player metadata. */
export class OxygenAuthority extends EventEmitter {
  private sample: Sample | null = null;
  private revision = 0;
  private reason = 'No own-entity air metadata observed';
  private dead = false;
  private ended = false;

  constructor(private readonly bot: Bot) {
    super();
    // Keep upstream/public readers on the same projection. Upstream and local
    // assignments carry no entity provenance and are deliberately ignored.
    // Unknown is NaN for the native number API, and null in structured evidence.
    Object.defineProperty(bot, 'oxygenLevel', {
      configurable: false, enumerable: true,
      get: () => this.snapshot().oxygen ?? Number.NaN, set: (_value: unknown) => {}
    });
    bot._client.prependListener('entity_metadata', this.onMetadata);
    bot._client.prependListener('login', this.onLogin);
    bot._client.prependListener('respawn', this.onRespawn);
    bot.on('death', this.onDeath);
    bot.once('end', this.onEnd);
  }

  snapshot(): OxygenEvidence {
    const sample = this.sample;
    if (this.ended || this.dead || !sample) return unknown(this.revision, this.reason);
    if (sample.entity !== this.bot.entity || sample.entityId !== this.bot.entity?.id || sample.dimension !== this.bot.game?.dimension) {
      return unknown(this.revision, 'Own air sample belongs to a previous player identity or dimension');
    }
    return {
      source: 'self_entity_metadata', known: true, entityId: sample.entityId,
      rawAirSupply: sample.rawAirSupply, oxygen: Math.round(sample.rawAirSupply / 15),
      revision: this.revision, observedAt: sample.observedAt,
      ageMs: Math.max(0, Date.now() - sample.observedAt), reason: null
    };
  }

  private invalidate(reason: string): void {
    this.sample = null; this.reason = reason; this.revision++;
    this.emit('change');
  }
  private readonly onLogin = (): void => { this.dead = false; this.invalidate('Waiting for own air after login'); };
  private readonly onRespawn = (): void => { this.dead = false; this.invalidate('Waiting for own air after respawn'); };
  private readonly onDeath = (): void => { this.dead = true; this.invalidate('Player died; own air is unknown'); };
  private readonly onEnd = (): void => {
    this.ended = true; this.invalidate('Session ended; own air is unknown');
    this.bot._client.removeListener('entity_metadata', this.onMetadata);
    this.bot._client.removeListener('login', this.onLogin);
    this.bot._client.removeListener('respawn', this.onRespawn);
    this.bot.removeListener('death', this.onDeath);
  };
  private readonly onMetadata = (packet: AirPacket): void => {
    if (this.ended || this.dead || !this.bot.entity || !Number.isSafeInteger(this.bot.entity.id) || packet.entityId !== this.bot.entity.id) return;
    // This public runtime only certifies Java 1.21.1/protocol 767. Derive the
    // player air index from its locked registry; do not guess other versions.
    const keys = (this.bot.registry.entitiesByName.player as { metadataKeys?: string[] } | undefined)?.metadataKeys;
    const key = keys?.indexOf('air_supply');
    if (this.bot.registry.version.version !== 767 || key === undefined || key < 0) return;
    if (!Array.isArray(packet.metadata)) return;
    const entries = packet.metadata.filter(entry => entry.key === key);
    if (!entries.length) return;
    const raw = entries[0].value;
    if (entries.length !== 1 || entries[0].type !== 'int' || typeof raw !== 'number' || !Number.isInteger(raw) || raw < -2147483648 || raw > 2147483647) {
      this.invalidate('Malformed or ambiguous own air metadata'); return;
    }
    // No 0..20 clamp: provenance, not plausibility, decides whether this is
    // the player's reading. Preserve raw negative and server-modified values.
    this.sample = { entity: this.bot.entity, entityId: packet.entityId, dimension: this.bot.game?.dimension, rawAirSupply: raw, observedAt: Date.now() };
    this.reason = ''; this.revision++;
    this.emit('change');
  };
}

export function installOxygenAuthority(bot: Bot): OxygenAuthority {
  let authority = authorities.get(bot);
  if (!authority) { authority = new OxygenAuthority(bot); authorities.set(bot, authority); }
  return authority;
}
export function getOxygenAuthority(bot: Bot): OxygenAuthority | undefined { return authorities.get(bot); }
export function readOxygenEvidence(bot: Bot): OxygenEvidence { return authorities.get(bot)?.snapshot() ?? unknown(); }
