"use server";

import { isValidObjectId } from "@/lib/d1-id";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { withEngagement } from "@/lib/cleanup";
import { importContactRows } from "@/lib/contact-import";
import { MAX_IMPORT_ROWS_PER_REQUEST } from "@/lib/csv-import";
import { connectDb } from "@/lib/db";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

export async function importContacts({ newsletterId, rows }) {
	await requireSession();
	if (!isValidObjectId(newsletterId)) return { error: "Newsletter not found" };
	if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS_PER_REQUEST) return { error: "Too many rows" };

	await connectDb();
	if (!(await Newsletter.exists({ _id: newsletterId }))) return { error: "Newsletter not found" };

	const result = await importContactRows({ newsletterId, rows });
	revalidatePath("/contacts");
	return result;
}

export async function setContactStatus(id, status) {
	await requireSession();
	if (!isValidObjectId(id) || !["active", "unsubscribed"].includes(status)) {
		return { error: "Invalid request" };
	}
	await connectDb();

	// Reactivation only applies to dormant contacts; unsubscribes, bounces and complaints are final. It
	// starts the list cleanup over, or the next send would make them dormant again.
	const filter =
		status === "active"
			? { _id: id, status: "dormant" }
			: { _id: id, status: { $in: ["active", "dormant", "pending"] } };
	const update =
		status === "active"
			? withEngagement({ $set: { status } })
			: { $set: { status, unsubscribedAt: new Date() } };
	const { modifiedCount } = await Contact.updateOne(filter, update);

	revalidatePath("/contacts");
	return modifiedCount ? { ok: true } : { error: "Status cannot change" };
}
