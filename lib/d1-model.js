import { connectDb } from "./db.js";
import { createId } from "./d1-id.js";
import { Sql, stored, tableName } from "./d1-sql.js";

const PAGE_SIZE = 200;
const DATE_KEYS = /(?:At$|^(?:at|activityAt|leftAt)$)/;

export function decodeDocument(text) {
	return JSON.parse(text, (key, value) => DATE_KEYS.test(key) && typeof value === "number" ? new Date(value) : value);
}

function prepare(db, sql, query) {
	return db.prepare(query).bind(...sql.values);
}

function databaseError(error) {
	if (/UNIQUE constraint failed/i.test(error?.message)) {
		const duplicate = new Error("A record with this unique key already exists", { cause: error });
		duplicate.code = 11000;
		return duplicate;
	}
	return error;
}

function mergeDefaults(defaults, input) {
	const result = { ...defaults, ...input };
	for (const [key, value] of Object.entries(defaults)) {
		if (value && typeof value === "object" && !Array.isArray(value) && input[key] && typeof input[key] === "object" && !Array.isArray(input[key])) result[key] = mergeDefaults(value, input[key]);
	}
	return result;
}

function getPath(document, path) { return path.split(".").reduce((value, key) => value?.[key], document); }
function setPath(document, path, value) {
	const keys = path.split(".");
	let parent = document;
	for (const key of keys.slice(0, -1)) parent = parent[key] ??= {};
	if (value === undefined) delete parent[keys.at(-1)];
	else parent[keys.at(-1)] = value;
}

function applyInsertUpdate(document, update) {
	for (const group of [update.$setOnInsert, update.$set]) for (const [field, value] of Object.entries(group ?? {})) setPath(document, field, stored(value));
	for (const [field, amount] of Object.entries(update.$inc ?? {})) setPath(document, field, (getPath(document, field) ?? 0) + amount);
	for (const op of ["$min", "$max"]) for (const [field, value] of Object.entries(update[op] ?? {})) {
		const previous = getPath(document, field);
		const next = stored(value);
		if (previous == null || (op === "$min" ? next < previous : next > previous)) setPath(document, field, next);
	}
	for (const field of Object.keys(update.$unset ?? {})) setPath(document, field, undefined);
	return document;
}

// Keyset pagination is stable when a consumer updates contacts while iterating.
function afterDocument(sort, document) {
	const prefix = {};
	const alternatives = [];
	for (const [field, direction] of Object.entries(sort)) {
		const value = getPath(document, field) ?? null;
		if (direction >= 0) alternatives.push({ ...prefix, [field]: value === null ? { $ne: null } : { $gt: value } });
		else if (value !== null) alternatives.push({ ...prefix, $or: [{ [field]: { $lt: value } }, { [field]: null }] });
		prefix[field] = value;
	}
	return { $or: alternatives };
}

function projectObject(document, spec) {
	if (!spec) return document;
	if (typeof spec === "string") spec = Object.fromEntries(spec.split(/\s+/).filter(Boolean).map((field) => [field.replace(/^-/, ""), field.startsWith("-") ? 0 : 1]));
	const includes = Object.entries(spec).filter(([, value]) => value);
	if (!includes.length) {
		const result = structuredClone(document);
		for (const field of Object.keys(spec)) setPath(result, field, undefined);
		return result;
	}
	const result = spec._id === 0 ? {} : { _id: document._id };
	for (const [field] of includes) if (getPath(document, field) !== undefined) setPath(result, field, getPath(document, field));
	return result;
}

class Query {
	constructor(model, filter = {}, single = false, mutation) {
		this.model = model;
		this.filter = filter;
		this.single = single;
		this.mutation = mutation;
		this.sorting = {};
		this.offset = 0;
		this.maximum = 0;
	}
	select(value) { this.projection = value; return this; }
	sort(value) { this.sorting = value; return this; }
	skip(value) { this.offset = Math.max(0, Number(value) || 0); return this; }
	limit(value) { this.maximum = Math.max(0, Number(value) || 0); return this; }
	lean() { this.plain = true; return this; }
	then(resolve, reject) { return this.exec().then(resolve, reject); }
	catch(reject) { return this.exec().catch(reject); }
	async exec() {
		if (this.mutation) {
			const result = await this.model._write(this.filter, this.mutation.update, this.mutation.options, false, true);
			const value = result.value && projectObject(result.value, this.projection);
			const document = value && (this.plain ? value : this.model._hydrate(value));
			return this.mutation.options.includeResultMetadata ? { value: document, lastErrorObject: { updatedExisting: result.upsertedCount === 0 } } : document;
		}
		const documents = [];
		for await (const document of this.cursor()) {
			documents.push(document);
			if (this.single) break;
		}
		return this.single ? documents[0] ?? null : documents;
	}
	async *cursor() {
		const db = await this.model._db();
		const sort = { ...this.sorting };
		if (!Object.hasOwn(sort, "_id")) sort._id = 1;
		let last;
		let fetched = 0;
		while (true) {
			const sql = new Sql();
			const filter = last ? { $and: [this.filter, afterDocument(sort, last)] } : this.filter;
			const limit = Math.min(PAGE_SIZE, this.single ? 1 : this.maximum ? this.maximum - fetched : PAGE_SIZE);
			if (limit <= 0) return;
			// Carry only sort keys alongside the projection, never the entire HTML body.
			const projection = sql.projection(this.projection);
			const keys = sql.projection(Object.fromEntries(Object.keys(sort).map((key) => [key, 1])));
			const query = `SELECT ${projection} AS document, ${keys} AS cursor FROM ${this.model.table} WHERE ${sql.where(filter)} ORDER BY ${sql.order(sort)} LIMIT ${sql.bind(limit)}${!last && this.offset ? ` OFFSET ${sql.bind(this.offset)}` : ""}`;
			const result = await prepare(db, sql, query).all();
			for (const row of result.results) {
				const document = decodeDocument(row.document);
				last = decodeDocument(row.cursor);
				fetched += 1;
				yield this.plain ? document : this.model._hydrate(document);
			}
			if (result.results.length < limit || this.single || (this.maximum && fetched >= this.maximum)) return;
		}
	}
}

export function defineModel(table, schema = {}, database = connectDb) {
	tableName(table);
	const normalize = (input) => {
		const document = stored(input);
		for (const field of schema.trim ?? []) {
			const value = getPath(document, field);
			if (typeof value === "string") setPath(document, field, value.trim());
		}
		for (const field of schema.lowercase ?? []) {
			const value = getPath(document, field);
			if (typeof value === "string") setPath(document, field, value.toLowerCase());
		}
		return document;
	};
	const validate = (document, partial = false) => {
		for (const field of schema.required ?? []) if ((!partial || Object.hasOwn(document, field)) && !getPath(document, field)) throw new Error(`${field} is required`);
		for (const [field, values] of Object.entries(schema.enums ?? {})) if (getPath(document, field) != null && !values.includes(getPath(document, field))) throw new Error(`Invalid ${field}`);
		for (const [field, min] of Object.entries(schema.min ?? {})) if (getPath(document, field) != null && getPath(document, field) < min) throw new Error(`${field} must be at least ${min}`);
	};
	const documentFor = (input) => {
		const now = Date.now();
		const document = normalize(mergeDefaults(stored(typeof schema.defaults === "function" ? schema.defaults() : schema.defaults ?? {}), stored(input)));
		document._id ??= createId();
		document.createdAt ??= now;
		document.updatedAt ??= now;
		validate(document);
		return document;
	};
	const model = {
		table,
		collection: { collectionName: table },
		_db: database,
		find(filter) { return new Query(model, filter); },
		findOne(filter) { return new Query(model, filter, true); },
		findById(id) { return model.findOne({ _id: id }); },
		findOneAndUpdate(filter, update, options = {}) { return new Query(model, filter, true, { update, options }); },
		async exists(filter) { return model.findOne(filter).select({ _id: 1 }).lean(); },
		async countDocuments(filter = {}) {
			const sql = new Sql();
			const row = await prepare(await model._db(), sql, `SELECT count(*) AS count FROM ${table} WHERE ${sql.where(filter)}`).first();
			return row.count;
		},
		async distinct(field, filter = {}) {
			const sql = new Sql();
			const result = await prepare(await model._db(), sql, `SELECT DISTINCT ${sql.field(field)} AS value FROM ${table} WHERE ${sql.where(filter)} AND ${sql.field(field)} IS NOT NULL`).all();
			return result.results.map(({ value }) => value);
		},
		async aggregate(stages) {
			const sql = new Sql();
			const query = sql.pipeline(table, stages);
			const result = await prepare(await model._db(), sql, query).all();
			return result.results.map(({ document }) => decodeDocument(document));
		},
		async create(input) {
			const document = documentFor(input);
			try { await (await model._db()).prepare(`INSERT INTO ${table} (document) VALUES (?)`).bind(JSON.stringify(document)).run(); }
			catch (error) { throw databaseError(error); }
			return model._hydrate(decodeDocument(JSON.stringify(document)));
		},
		async insertMany(inputs, { ordered = true } = {}) {
			const db = await model._db();
			const documents = inputs.map(documentFor);
			for (let i = 0; i < documents.length; i += 50) {
				const statements = documents.slice(i, i + 50).map((document) => db.prepare(`INSERT INTO ${table} (document) VALUES (?)${ordered ? "" : " ON CONFLICT DO NOTHING"}`).bind(JSON.stringify(document)));
				try { await db.batch(statements); } catch (error) { throw databaseError(error); }
			}
			return documents.map((document) => model._hydrate(decodeDocument(JSON.stringify(document))));
		},
		updateOne(filter, update, options = {}) { return model._write(filter, update, options); },
		updateMany(filter, update, options = {}) { return model._write(filter, update, options, true); },
		async _write(filter, update, options = {}, many = false, returnValue = false) {
			const db = await model._db();
			const plan = model._writePlan(db, filter, update, options, many, returnValue);
			try { return plan.read(await db.batch(plan.statements)); } catch (error) { throw databaseError(error); }
		},
		_writePlan(db, filter, update, options, many, returnValue) {
			const now = Date.now();
			const normalizedSet = {};
			for (const [field, value] of Object.entries(update.$set ?? {})) {
				const holder = {}; setPath(holder, field, value);
				normalizedSet[field] = getPath(normalize(holder), field);
			}
			update = { ...update, $set: { ...normalizedSet, updatedAt: now } };
			const partial = {}; for (const [field, value] of Object.entries(update.$set)) setPath(partial, field, value);
			validate(partial, true);
			const statements = [];
			let beforeIndex;
			if (returnValue && options.returnDocument !== "after") {
				const sql = new Sql();
				beforeIndex = statements.length;
				statements.push(prepare(db, sql, `SELECT document FROM ${table} WHERE ${sql.where(filter)} LIMIT 1`));
			}
			let insertIndex;
			let insertedId;
			if (options.upsert) {
				if (many) throw new Error("updateMany upserts are not supported");
				const base = {};
				for (const [field, value] of Object.entries(filter)) if (!field.startsWith("$") && (value === null || typeof value !== "object" || value instanceof Date)) setPath(base, field, value);
				const defaults = typeof schema.defaults === "function" ? schema.defaults() : schema.defaults ?? {};
				const document = documentFor(applyInsertUpdate({ ...stored(defaults), ...stored(base) }, update));
				insertedId = document._id;
				const sql = new Sql();
				const value = sql.bind(JSON.stringify(document));
				insertIndex = statements.length;
				statements.push(prepare(db, sql, `INSERT INTO ${table} (document) SELECT ${value} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${sql.where(filter)}) RETURNING document`));
			}
			const sql = new Sql();
			const expression = sql.update(update);
			const match = sql.where(insertedId ? { $and: [filter, { _id: { $ne: insertedId } }] } : filter);
			const where = many ? match : `rowid = (SELECT rowid FROM ${table} WHERE ${match} LIMIT 1)`;
			const updateIndex = statements.length;
			statements.push(prepare(db, sql, `UPDATE ${table} SET document = ${expression} WHERE ${where}${returnValue ? " RETURNING document" : ""}`));
			return {
				statements,
				read(results) {
					const upsertedCount = insertIndex === undefined ? 0 : results[insertIndex].meta.changes;
					const matchedCount = results[updateIndex].meta.changes;
					const document = beforeIndex !== undefined ? results[beforeIndex].results[0]?.document : (upsertedCount ? results[insertIndex] : results[updateIndex]).results[0]?.document;
					return { matchedCount, modifiedCount: matchedCount, upsertedCount, upsertedId: upsertedCount ? insertedId : null, ...(returnValue && { value: document ? decodeDocument(document) : null }) };
				},
			};
		},
		async bulkWrite(operations) {
			const db = await model._db();
			const totals = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
			for (let i = 0; i < operations.length; i += 40) {
				const plans = operations.slice(i, i + 40).map(({ updateOne }) => {
					if (!updateOne) throw new Error("Only updateOne bulk operations are supported");
					return model._writePlan(db, updateOne.filter, updateOne.update, { upsert: updateOne.upsert }, false, false);
				});
				let results;
				try { results = await db.batch(plans.flatMap(({ statements }) => statements)); } catch (error) { throw databaseError(error); }
				let offset = 0;
				for (const plan of plans) {
					const result = plan.read(results.slice(offset, offset + plan.statements.length));
					for (const key of Object.keys(totals)) totals[key] += result[key];
					offset += plan.statements.length;
				}
			}
			return totals;
		},
		_hydrate(document) {
			let snapshot = stored(document);
			Object.defineProperty(document, "save", { enumerable: false, value: async () => {
				const current = stored(document);
				const $set = {};
				const $unset = {};
				function diff(before, after, prefix = "") {
					for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
						if (!prefix && ["_id", "createdAt", "updatedAt"].includes(key)) continue;
						const path = prefix ? `${prefix}.${key}` : key;
						const previous = before?.[key]; const next = after?.[key];
						if (JSON.stringify(previous) === JSON.stringify(next)) continue;
						if (next === undefined) $unset[path] = 1;
						else if (previous && next && typeof previous === "object" && typeof next === "object" && !Array.isArray(next)) diff(previous, next, path);
						else $set[path] = next;
					}
				}
				diff(snapshot, current);
				if (Object.keys($set).length || Object.keys($unset).length) await model.updateOne({ _id: document._id }, { $set, $unset });
				snapshot = current;
				return document;
			} });
			return document;
		},
	};
	return model;
}
