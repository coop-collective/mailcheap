import assert from "node:assert/strict";
import { test } from "node:test";
import { convertExportDocument, exportDocumentSql } from "../lib/d1-import.js";

const id = "0123456789abcdef01234567";
test("Mongo exports preserve signed-link IDs, timestamps, opt-outs and provider IDs", () => {
	const result = convertExportDocument({ _id: { $oid: id }, newsletterId: { $oid: "ABCDEF0123456789ABCDEF01" }, status: "unsubscribed", __v: 5, createdAt: { $date: "2026-10-10T00:00:00.000Z" }, unsubscribedAt: { $date: { $numberLong: "1791586800000" } }, stats: { sent: { $numberLong: "123" } }, sesMessageId: "old-provider-id" });
	assert.equal(result._id, id);
	assert.equal(result.newsletterId, "abcdef0123456789abcdef01");
	assert.equal(result.status, "unsubscribed");
	assert.equal(result.createdAt, Date.parse("2026-10-10T00:00:00.000Z"));
	assert.equal(result.unsubscribedAt, 1791586800000);
	assert.equal(result.stats.sent, 123);
	assert.equal(result.providerMessageId, "old-provider-id");
	assert.equal(result.__v, undefined);
});

test("SQL export quotes content safely and rejects unknown tables or damaged IDs", () => {
	const sql = exportDocumentSql("campaigns", { _id: id, html: "O'Reilly\n<script>$()</script>" });
	assert.ok(sql.includes("O''Reilly\\n<script>$()</script>"));
	assert.throws(() => exportDocumentSql("campaigns; DROP TABLE contacts", { _id: id }), /Unknown D1 table/);
	assert.throws(() => convertExportDocument({ _id: "damaged" }), /original 24-hex/);
	assert.throws(() => convertExportDocument({ _id: id, createdAt: { $date: "bad" } }), /Invalid date/);
	assert.throws(() => convertExportDocument({ _id: id, stats: { sent: { $numberLong: "9007199254740992" } } }), /Unsafe numeric/);
});
