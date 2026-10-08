/**
 * An `Instant` as the schema says it travels (spec 01, scalar table): RFC 3339 in UTC. The services keep epoch
 * milliseconds in their columns, because a bigint orders and compares for free; these two are the only crossing
 * between the two forms, at the store's edge.
 */
export const instant = (ms: number): string => new Date(ms).toISOString();

/** The milliseconds an RFC 3339 instant names, for a column or a comparison. Text sorts wrongly across offsets and precisions. */
export const millis = (rfc3339: string): number => Date.parse(rfc3339);
