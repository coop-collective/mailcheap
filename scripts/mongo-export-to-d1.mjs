#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { once } from "node:events";
import { exportDocumentSql } from "../lib/d1-import.js";

// Usage: node scripts/mongo-export-to-d1.mjs ./mongo-exports ./mailcheap-import.sql
// Input: one mongoexport NDJSON file per collection (<collection>.json or .ndjson).
// This produces a local SQL artifact only. It never connects to either database.
const [inputDirectory, outputFile] = process.argv.slice(2);
if (!inputDirectory || !outputFile) {
	console.error("Usage: node scripts/mongo-export-to-d1.mjs <export-directory> <output.sql>");
	process.exitCode = 1;
} else {
	const output = createWriteStream(resolve(outputFile), { flags: "wx", mode: 0o600 });
	const opened = once(output, "open");
	// Keep errors observed while processing the stream; writing will reject too.
	let outputError;
	output.on("error", (error) => { outputError = error; });
	try {
		await opened;
		let total = 0;
		for (const collection of ["newsletters", "contacts", "campaigns", "messages", "suppressions", "events", "alerts", "apikeys"]) {
			let inputFile;
			for (const extension of ["ndjson", "json"]) {
				const candidate = resolve(inputDirectory, `${collection}.${extension}`);
				if (await access(candidate).then(() => true, () => false)) { inputFile = candidate; break; }
			}
			if (!inputFile) continue;
			let lineNumber = 0;
			let count = 0;
			const lines = createInterface({ input: createReadStream(inputFile), crlfDelay: Infinity });
			for await (const line of lines) {
				lineNumber += 1;
				if (!line.trim()) continue;
				try {
					const sql = exportDocumentSql(collection, JSON.parse(line));
					if (outputError) throw outputError;
					if (!output.write(`${sql}\n`)) await once(output, "drain");
					count += 1;
				} catch (error) { throw new Error(`${collection}:${lineNumber}: ${error.message}`); }
			}
			console.log(`${collection}: ${count} records`);
			total += count;
		}
		if (!total) throw new Error("No collection records found; use mongoexport's default newline-delimited JSON format");
		output.end();
		await once(output, "finish");
		console.log(`Wrote ${total} records to ${resolve(outputFile)}. Apply schema migrations first; review and import into an empty D1 database with sending disabled.`);
	} catch (error) {
		output.destroy();
		console.error(error.message);
		console.error("Import file is incomplete; do not execute it. Remove it before retrying.");
		process.exitCode = 1;
	}
}
