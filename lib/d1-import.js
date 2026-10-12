import { isValidObjectId } from "./d1-id.js";
import { tableName } from "./d1-sql.js";

const IDS = new Set(["_id", "newsletterId", "campaignId", "contactId", "messageId"]);

// Accept mongoexport's relaxed or canonical Extended JSON without needing a
// MongoDB driver, credentials, or a database connection in the application.
export function convertExportDocument(input) {
	function convert(value, key = "") {
		if (Array.isArray(value)) return value.map((item) => convert(item));
		if (value && typeof value === "object") {
			if (Object.keys(value).length === 1 && Object.hasOwn(value, "$oid")) {
				if (!isValidObjectId(value.$oid)) throw new Error(`Invalid ObjectId in ${key}`);
				return value.$oid.toLowerCase();
			}
			if (Object.keys(value).length === 1 && Object.hasOwn(value, "$date")) {
				const date = value.$date;
				const result = typeof date === "object" ? Number(date.$numberLong) : new Date(date).getTime();
				if (!Number.isFinite(result)) throw new Error(`Invalid date in ${key}`);
				return result;
			}
			for (const type of ["$numberLong", "$numberInt", "$numberDouble", "$numberDecimal"]) {
				if (Object.keys(value).length === 1 && Object.hasOwn(value, type)) {
					const number = Number(value[type]);
					if (!Number.isFinite(number) || (type === "$numberLong" && !Number.isSafeInteger(number))) throw new Error(`Unsafe numeric value in ${key}`);
					return number;
				}
			}
			return Object.fromEntries(Object.entries(value).filter(([field]) => field !== "__v").map(([field, item]) => [field === "sesMessageId" ? "providerMessageId" : field, convert(item, field)]));
		}
		if (IDS.has(key) && typeof value === "string" && isValidObjectId(value)) return value.toLowerCase();
		if (/At$/.test(key) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
			const result = new Date(value).getTime();
			if (!Number.isFinite(result)) throw new Error(`Invalid date in ${key}`);
			return result;
		}
		return value;
	}
	const document = convert(input);
	if (!isValidObjectId(document?._id)) throw new Error("Every imported document must retain its original 24-hex _id");
	return document;
}

export function exportDocumentSql(collection, input) {
	const table = tableName(collection);
	const document = convertExportDocument(input);
	return `INSERT INTO ${table} (document) VALUES ('${JSON.stringify(document).replaceAll("'", "''")}');`;
}
