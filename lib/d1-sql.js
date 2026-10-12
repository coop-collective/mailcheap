// A deliberately bounded query vocabulary, compiled to parameterized SQLite.
// No rows are loaded into JavaScript to filter, sort, join, count, or update them.
const TABLES = new Set(["newsletters", "campaigns", "contacts", "messages", "suppressions", "events", "alerts", "apikeys"]);
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function tableName(value) {
	if (!TABLES.has(value)) throw new Error(`Unknown D1 table: ${value}`);
	return value;
}

export function jsonPath(path) {
	if (!PATH.test(path)) throw new Error(`Invalid document field: ${path}`);
	return `'$.${path}'`;
}

export function stored(value) {
	if (value instanceof Date) return value.getTime();
	if (Array.isArray(value)) return value.map(stored);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stored(entry)]));
	return value;
}

export class Sql {
	values = [];
	aliases = 0;
	bind(value) {
		const normalized = stored(value);
		const result = typeof normalized === "boolean" ? Number(normalized) : normalized ?? null;
		this.values.push(result !== null && typeof result === "object" ? JSON.stringify(result) : result);
		return `?${this.values.length}`;
	}
	field(path, doc = "document") { return `json_extract(${doc}, ${jsonPath(path)})`; }
	expr(value, doc = "document") {
		if (typeof value === "string" && value.startsWith("$")) return this.field(value.slice(1), doc);
		if (!value || typeof value !== "object" || value instanceof Date) return this.bind(value);
		if (Array.isArray(value)) return `json(${this.bind(value)})`;
		const entries = Object.entries(value);
		if (!entries.some(([key]) => key.startsWith("$"))) return `json_object(${entries.flatMap(([key, item]) => [this.bind(key), this.expr(item, doc)]).join(", ")})`;
		if (entries.length !== 1) throw new Error("An SQL expression must have one operator");
		const [op, argument] = entries[0];
		const args = () => argument.map((item) => this.expr(item, doc));
		if (op === "$ifNull") return `coalesce(${args().join(", ")})`;
		if (op === "$cond") {
			const [condition, yes, no] = args();
			return `(CASE WHEN ${condition} THEN ${yes} ELSE ${no} END)`;
		}
		if (op === "$max" || op === "$min") {
			// SQLite scalar max/min propagates NULL; the aggregate form ignores it.
			return `(SELECT ${op.slice(1)}(value) FROM json_each(json_array(${args().join(", ")})))`;
		}
		if (op === "$abs") return `abs(${this.expr(argument, doc)})`;
		if (op === "$add" || op === "$subtract") return `(${args().join(op === "$add" ? " + " : " - ")})`;
		if (op === "$and" || op === "$or") return `(${args().join(op === "$and" ? " AND " : " OR ")})`;
		if (op === "$not") return `(NOT coalesce(${this.expr(argument[0], doc)}, 0))`;
		if (op === "$in") {
			const [left, values] = argument;
			return `(${this.expr(left, doc)} IN (SELECT value FROM json_each(${this.bind(values)})))`;
		}
		const comparisons = { $eq: "IS", $ne: "IS NOT", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" };
		if (comparisons[op]) {
			const [a, b] = argument;
			const left = this.expr(a, doc);
			const right = this.expr(b, doc);
			if (op === "$eq" || op === "$ne") return `(${left} ${comparisons[op]} ${right})`;
			// Document expressions sort a null/missing value before every non-null
			// value. SQL's unknown comparison result would miscount engagement.
			const nullLeft = op === "$lt" ? `${right} IS NOT NULL` : op === "$lte" ? "1" : op === "$gte" ? `${right} IS NULL` : "0";
			const nullRight = op === "$gt" || op === "$gte" ? "1" : "0";
			return `(CASE WHEN ${left} IS NULL THEN ${nullLeft} WHEN ${right} IS NULL THEN ${nullRight} ELSE ${left} ${comparisons[op]} ${right} END)`;
		}
		if (op === "$first") {
			const [head, ...rest] = argument.slice(1).split(".");
			jsonPath(argument.slice(1));
			return `json_extract(${doc}, '$.${head}[0]${rest.length ? `.${rest.join(".")}` : ""}')`;
		}
		// IANA timezone boundaries are calculated by Intl in the report layer. D1
		// groups in SQL, including 23/25-hour DST days, without loading messages.
		if (op === "$dateBucket") {
			const date = this.expr(argument.date, doc);
			return `(SELECT json_extract(value, '$.value') FROM json_each(${this.bind(argument.buckets)}) WHERE ${date} >= json_extract(value, '$.start') AND ${date} < json_extract(value, '$.end') LIMIT 1)`;
		}
		throw new Error(`Unsupported D1 expression: ${op}`);
	}
	where(filter = {}, doc = "document") {
		const clauses = [];
		for (const [key, value] of Object.entries(filter)) {
			if (key === "$or" || key === "$and") {
				clauses.push(`(${value.map((item) => this.where(item, doc)).join(key === "$or" ? " OR " : " AND ") || (key === "$or" ? "0" : "1")})`);
				continue;
			}
			if (key === "$expr") { clauses.push(this.expr(value, doc)); continue; }
			const field = this.field(key, doc);
			if (!value || typeof value !== "object" || value instanceof Date || Array.isArray(value)) {
				clauses.push(`${field} IS ${this.bind(value)}`);
				if (typeof value === "string") clauses.push(`json_type(${doc}, ${jsonPath(key)}) = 'text'`);
				continue;
			}
			for (const [op, operand] of Object.entries(value)) {
				const comparisons = { $eq: "IS", $ne: "IS NOT", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" };
				if (comparisons[op]) clauses.push(`${field} ${comparisons[op]} ${this.bind(operand)}`);
				else if (op === "$in" || op === "$nin") {
					// One JSON parameter avoids D1's bound-variable limit on large imports.
					const membership = `${field} IN (SELECT value FROM json_each(${this.bind(operand)}))`;
					const contains = operand.includes(null) ? `(${field} IS NULL OR ${membership})` : membership;
					clauses.push(op === "$nin" ? `NOT coalesce(${contains}, 0)` : contains);
				} else if (op === "$exists") clauses.push(`json_type(${doc}, ${jsonPath(key)}) IS ${operand ? "NOT " : ""}NULL`);
				else if (op === "$type") {
					const types = { string: "text", date: "integer", number: "real", bool: "true" };
					if (!types[operand]) throw new Error(`Unsupported field type: ${operand}`);
					clauses.push(operand === "date" || operand === "number" ? `json_type(${doc}, ${jsonPath(key)}) IN ('integer', 'real')` : operand === "bool" ? `json_type(${doc}, ${jsonPath(key)}) IN ('true', 'false')` : `json_type(${doc}, ${jsonPath(key)}) = '${types[operand]}'`);
				} else if (op === "$regex") {
					// The contacts UI only performs a case-sensitive, escaped prefix search.
					if (!operand.startsWith("^") || /(?<!\\)[.*+?()[\]{}|$]/.test(operand.slice(1))) throw new Error("Only literal prefix searches are supported");
					const prefix = operand.slice(1).replace(/\\(.)/g, "$1");
					clauses.push(`${field} >= ${this.bind(prefix)} AND ${field} < ${this.bind(`${prefix}\uffff`)}`);
				} else throw new Error(`Unsupported D1 filter: ${op}`);
			}
		}
		return clauses.length ? clauses.map((item) => `(${item})`).join(" AND ") : "1";
	}
	order(sort = {}, doc = "document") {
		return Object.entries(sort).map(([field, direction]) => `${this.field(field, doc)} ${direction < 0 ? "DESC" : "ASC"}`).join(", ");
	}
	projection(spec, doc = "document") {
		if (!spec || !Object.keys(spec).length) return doc;
		if (typeof spec === "string") spec = Object.fromEntries(spec.split(/\s+/).filter(Boolean).map((field) => [field.replace(/^-/, ""), field.startsWith("-") ? 0 : 1]));
		const entries = Object.entries(spec);
		const included = entries.filter(([, value]) => value !== 0);
		if (!included.length) return `json_remove(${doc}, ${entries.map(([field]) => jsonPath(field)).join(", ")})`;
		if (!Object.hasOwn(spec, "_id")) included.unshift(["_id", 1]);
		return `json_set('{}', ${included.flatMap(([key, value]) => [jsonPath(key), value === 1 ? `json(${doc} -> ${jsonPath(key)})` : this.expr(value, doc)]).join(", ")})`;
	}
	update(update, doc = "document") {
		const supported = new Set(["$set", "$unset", "$inc", "$min", "$max", "$setOnInsert"]);
		for (const key of Object.keys(update)) if (!supported.has(key)) throw new Error(`Unsupported D1 update: ${key}`);
		const pairs = [];
		for (const [field, value] of Object.entries(update.$set ?? {})) {
			if (value !== undefined) pairs.push(jsonPath(field), `json(${this.bind(JSON.stringify(stored(value)))})`);
		}
		for (const [field, value] of Object.entries(update.$inc ?? {})) pairs.push(jsonPath(field), `(coalesce(${this.field(field, doc)}, 0) + ${this.bind(value)})`);
		for (const op of ["$min", "$max"]) {
			for (const [field, value] of Object.entries(update[op] ?? {})) {
				const current = this.field(field, doc);
				const desired = this.bind(value);
				pairs.push(jsonPath(field), `(CASE WHEN ${current} IS NULL OR ${current} ${op === "$min" ? ">" : "<"} ${desired} THEN ${desired} ELSE ${current} END)`);
			}
		}
		let result = pairs.length ? `json_set(${doc}, ${pairs.join(", ")})` : doc;
		if (Object.keys(update.$unset ?? {}).length) result = `json_remove(${result}, ${Object.keys(update.$unset).map(jsonPath).join(", ")})`;
		return result;
	}
	pipeline(table, stages, initialWhere) {
		let query = `SELECT document FROM ${tableName(table)}${initialWhere ? ` WHERE ${initialWhere}` : ""}`;
		for (const stage of stages) {
			const alias = `s${this.aliases++}`;
			const doc = `${alias}.document`;
			const source = `(${query}) AS ${alias}`;
			const [op, value] = Object.entries(stage)[0];
			if (op === "$match") query = `SELECT ${doc} FROM ${source} WHERE ${this.where(value, doc)}`;
			else if (op === "$sort") query = `SELECT ${doc} FROM ${source} ORDER BY ${this.order(value, doc)}`;
			else if (op === "$limit") query = `SELECT ${doc} FROM ${source} LIMIT ${this.bind(value)}`;
			else if (op === "$project") query = `SELECT ${this.projection(value, doc)} AS document FROM ${source}`;
			else if (op === "$set" || op === "$addFields") query = `SELECT json_set(${doc}, ${Object.entries(value).flatMap(([key, item]) => [jsonPath(key), this.expr(item, doc)]).join(", ")}) AS document FROM ${source}`;
			else if (op === "$unset") query = `SELECT json_remove(${doc}, ${[value].flat().map(jsonPath).join(", ")}) AS document FROM ${source}`;
			else if (op === "$group") {
				const key = this.expr(value._id, doc);
				const sums = Object.entries(value).filter(([field]) => field !== "_id").flatMap(([field, aggregate]) => {
					if (!Object.hasOwn(aggregate, "$sum")) throw new Error("Only SQL SUM grouping is supported");
					return [this.bind(field), `coalesce(sum(${this.expr(aggregate.$sum, doc)}), 0)`];
				});
				query = `SELECT json_object('_id', ${key}${sums.length ? `, ${sums.join(", ")}` : ""}) AS document FROM ${source} GROUP BY ${key}`;
			} else if (op === "$count") query = `SELECT json_object(${this.bind(value)}, count(*)) AS document FROM ${source} HAVING count(*) > 0`;
			else if (op === "$lookup") {
				const condition = `${this.field(value.foreignField)} IS ${this.field(value.localField, doc)}`;
				const inner = this.pipeline(value.from, value.pipeline ?? [], condition);
				query = `SELECT json_set(${doc}, ${jsonPath(value.as)}, json((SELECT json_group_array(json(document)) FROM (${inner})))) AS document FROM ${source}`;
			} else if (op === "$unwind") {
				const path = value.replace(/^\$/, "");
				query = `SELECT json_set(${doc}, ${jsonPath(path)}, json(j.value)) AS document FROM ${source}, json_each(${this.field(path, doc)}) AS j`;
			} else throw new Error(`Unsupported D1 pipeline stage: ${op}`);
		}
		return query;
	}
}
