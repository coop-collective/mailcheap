import { hourIn, shiftDateKey, startOfDateKey } from "./time-zone.js";

// SQLite has no IANA timezone database. Supply a small boundary table from Intl,
// then let D1 aggregate against it instead of transferring every event to JS.
export function dayBuckets(keys, timeZone) {
	return keys.map((key) => ({
		start: startOfDateKey(key, timeZone).getTime(),
		end: startOfDateKey(shiftDateKey(key, 1), timeZone).getTime(),
		value: key,
	}));
}

export function hourBuckets(keys, timeZone) {
	const buckets = [];
	for (const { start, end } of dayBuckets(keys, timeZone)) {
		// Modern timezone transitions include 30-minute DST changes; quarter-hour
		// steps also preserve zones with 45-minute offsets.
		for (let at = start; at < end; at += 15 * 60_000) {
			const value = hourIn(new Date(at), timeZone);
			const next = Math.min(at + 15 * 60_000, end);
			const previous = buckets.at(-1);
			if (previous?.value === value && previous.end === at) previous.end = next;
			else buckets.push({ start: at, end: next, value });
		}
	}
	return buckets;
}
